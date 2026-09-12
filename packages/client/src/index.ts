import type { RoomOptions, RoomState } from "./types.js";
export type * from "./types.js";
import { Socket } from "phoenix";
import { PhoenixChannelProvider } from "y-phoenix-channel";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { chunkedSocket } from "./chunked-transport.js";
import { trackSaveStatus } from "./save-status.js";
import { sessionAccess, SynixirError, normalizeError } from "./access.js";

export { SynixirError };

/** Owns one account's local document, awareness, and recoverable room connection. */
export class SynixirRoom {
  #doc: Y.Doc;
  #awareness: Awareness;
  #roomId: string;
  #userId: string;
  #serverUrl: URL;
  #getAccess: NonNullable<RoomOptions["getAccess"]>;
  #listeners = new Set<(state: RoomState) => void>();
  #state: RoomState = Object.freeze({ connection: "disconnected", role: null, readOnly: true,
    saveStatus: "not-saved", hasUnsavedChanges: false, error: null, saveError: null });
  #saves: ReturnType<typeof trackSaveStatus>;
  #generation = 0;
  #controller?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #retries = 0;
  #wanted = false;
  #frozen = false;
  #destroyed = false;
  #pending?: { promise: Promise<void>; resolve: () => void; reject: (error: SynixirError) => void };
  #active?: {socket: Socket; provider: PhoenixChannelProvider; transport: ReturnType<typeof chunkedSocket>};
  #socketClosed = Promise.resolve();

  constructor({ roomId, userId, serverUrl = globalThis.location?.origin, getAccess }: RoomOptions) {
    if (typeof roomId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(roomId)) {
      throw new TypeError("roomId must contain 1–128 ASCII letters, digits, underscores or hyphens and start with a letter or digit");
    }
    if (typeof userId !== "string" || !userId.trim()) throw new TypeError("userId is required");
    const url = new URL(serverUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new TypeError("serverUrl must be an HTTP(S) origin");
    if (getAccess !== undefined && typeof getAccess !== "function") throw new TypeError("getAccess must be a function");
    this.#roomId = roomId;
    this.#userId = userId;
    this.#serverUrl = url;
    this.#getAccess = getAccess ?? sessionAccess(url, userId);
    this.#doc = new Y.Doc();
    this.#awareness = new Awareness(this.#doc);
    this.#saves = trackSaveStatus(this.#doc, state => this.#publish(state));
    this.#doc.on("destroy", () => { void this.destroy(); });
  }

  get doc() { return this.#doc; }
  get awareness() { return this.#awareness; }
  get state() { return this.#state; }

  /** Immediately receives the current immutable state. Returns an unsubscribe function. */
  subscribe(listener: (state: RoomState) => void) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    if (!this.#destroyed) this.#listeners.add(listener);
    this.#notify(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #notify(listener: (state: RoomState) => void) {
    try { listener(this.#state); }
    catch (error) {
      // A rendering error must not stop cleanup, saving, or other subscribers.
      if (globalThis.reportError) globalThis.reportError(error);
      else queueMicrotask(() => { throw error; });
    }
  }

  #publish(changes: Partial<RoomState>) {
    const state = { ...this.#state, ...changes };
    state.readOnly = this.#destroyed || this.#frozen || !state.role || state.role === "viewer";
    if (state.role === "viewer") {
      state.saveStatus = "view-only";
      state.hasUnsavedChanges = false;
      state.saveError = null;
    }
    if ((Object.keys(state) as (keyof RoomState)[]).every(key => state[key] === this.#state[key])) return;
    this.#state = Object.freeze(state);
    for (const listener of this.#listeners) this.#notify(listener);
  }

  /** Resolves on synchronization, separately from durable save confirmation. */
  connect() {
    if (this.#destroyed) return Promise.reject(new SynixirError("destroyed"));
    if (this.#frozen) return Promise.reject(this.#state.error);
    if (this.#pending) return this.#pending.promise;
    if (this.#state.connection === "connected") return Promise.resolve();
    this.#wanted = true;
    clearTimeout(this.#retryTimer);
    const generation = ++this.#generation;
    const controller = this.#controller = new AbortController();
    let resolve!: () => void, reject!: (error: SynixirError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.#pending = { promise, resolve, reject };
    this.#publish({ connection: this.#retries ? "reconnecting" : "connecting", error: null });
    if (generation !== this.#generation || this.#destroyed) return promise;
    // Bound even a custom access callback that ignores its AbortSignal.
    this.#timer = setTimeout(() => this.#fail(generation,
      new SynixirError("timeout", { retryable: true })), 10_000);
    void this.#start(generation, controller.signal);
    return promise;
  }

  async #start(generation: number, signal: AbortSignal) {
    const current = () => generation === this.#generation && !this.#destroyed;
    try {
      const access = await this.#getAccess({ roomId: this.#roomId, signal });
      if (!current()) return;
      if (access?.userId !== this.#userId) throw new SynixirError("account_changed");
      if (!["owner", "editor", "viewer"].includes(access.role) || typeof access.token !== "string" || !access.token) {
        throw new SynixirError("invalid_access");
      }
      if (this.#state.role && access.role !== this.#state.role) throw new SynixirError("access_changed");
      clearTimeout(this.#timer);
      await this.#socketClosed;
      if (!current()) return;
      const writable = access.role !== "viewer";
      const socket = new Socket(new URL("/socket", this.#serverUrl).href);
      const transport = chunkedSocket(socket, writable);
      const provider = new PhoenixChannelProvider(transport as unknown as Socket, `document:${this.#roomId}`, this.#doc, {
        connect: false, disableBc: true, awareness: this.#awareness, params: { token: access.token },
      });
      this.#active = { socket, provider, transport };
      this.#saves.attach(provider, writable);
      this.#publish({ role: access.role });
      if (!current()) return;
      // Transfers have their own 30-second deadline; the initial handshake also
      // needs a bound if a peer sends no sync response at all.
      this.#timer = setTimeout(() => this.#fail(generation, new SynixirError("sync_timeout")), 45_000);
      provider.on("sync", synced => {
        if (!current() || !synced) return;
        clearTimeout(this.#timer);
        this.#retries = 0;
        this.#awareness.setLocalState(this.#awareness.getLocalState());
        this.#publish({ connection: "connected", error: null });
        if (current()) this.#settle();
      });
      provider.on("status", ({ status }) => {
        if (status === "disconnected") this.#fail(generation, new SynixirError("disconnected", { retryable: true }));
      });
      socket.onError(() => this.#fail(generation, new SynixirError("network_error", { retryable: true })));
      socket.onClose(() => this.#fail(generation, new SynixirError("disconnected", { retryable: true })));
      socket.connect();
      provider.connect();
      const channel = provider.channel!;
      channel.on("access_revoked", () => this.#fail(generation, new SynixirError("access_changed")));
      channel.on("sync_error", ({ reason }) => this.#fail(generation, new SynixirError(reason ?? "sync_failed")));
      channel.joinPush.receive("error", ({ reason }) => this.#fail(generation, new SynixirError(reason ?? "room_unavailable")));
      channel.joinPush.receive("timeout", () => this.#fail(generation, new SynixirError("timeout", { retryable: true })));
    } catch (error) {
      this.#fail(generation, normalizeError(error));
    }
  }

  #settle(error?: SynixirError) {
    const pending = this.#pending;
    this.#pending = undefined;
    if (error) pending?.reject(error);
    else pending?.resolve();
  }

  #stop(error: SynixirError) {
    this.#generation++;
    clearTimeout(this.#timer);
    clearTimeout(this.#retryTimer);
    this.#controller?.abort();
    this.#controller = undefined;
    this.#settle(error);
    this.#saves.detach();
    const active = this.#active;
    this.#active = undefined;
    if (active) {
      active.provider.destroy();
      active.transport.destroy();
      this.#socketClosed = this.#socketClosed.then(() => new Promise<void>(resolve => active.socket.disconnect(resolve)));
    }
    removeAwarenessStates(this.#awareness,
      [...this.#awareness.getStates().keys()].filter(id => id !== this.#doc.clientID), this);
    return this.#socketClosed;
  }

  #fail(generation: number, error: SynixirError) {
    if (generation !== this.#generation || this.#destroyed) return;
    this.#frozen = ["access_changed", "account_changed"].includes(error.code);
    const retry = this.#wanted && error.retryable && !this.#frozen;
    if (!retry) this.#wanted = false;
    this.#stop(error);
    const stoppedGeneration = this.#generation;
    this.#publish({ ...this.#saves.state, connection: retry ? "reconnecting" : "error", error });
    if (retry && this.#wanted && !this.#destroyed && stoppedGeneration === this.#generation) {
      const delay = Math.min(250 * 2 ** Math.min(this.#retries++, 5), 5_000);
      this.#retryTimer = setTimeout(() => { void this.connect().catch(() => {}); }, delay);
    }
  }

  /** Cancels pending work and waits for socket shutdown; retains the document. */
  disconnect() {
    if (this.#destroyed) return this.#socketClosed;
    this.#wanted = false;
    this.#retries = 0;
    const closed = this.#stop(new SynixirError("disconnected"));
    this.#publish({ ...this.#saves.state, connection: "disconnected" });
    return closed;
  }

  /** Terminal and idempotent. Destroys the owned document and awareness. */
  destroy() {
    if (this.#destroyed) return this.#socketClosed;
    this.#destroyed = true;
    this.#wanted = false;
    const closed = this.#stop(new SynixirError("destroyed"));
    this.#saves.destroy();
    this.#publish({ ...this.#saves.state, connection: "destroyed" });
    this.#listeners.clear();
    if (!this.#doc.isDestroyed) this.#doc.destroy();
    return closed;
  }
}
