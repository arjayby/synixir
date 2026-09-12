import type { PhoenixChannelProvider } from "y-phoenix-channel";
import type { RoomState } from "./types.js";
type SaveState = Pick<RoomState, "saveStatus" | "saveError" | "hasUnsavedChanges">;
import * as Y from "yjs";

// A sync handshake is not a database acknowledgement. Keep revisions across
// transports, but accept save replies only from the currently attached one.
export function trackSaveStatus(doc: Y.Doc, render: (state: SaveState) => void) {
  let provider: PhoenixChannelProvider | undefined;
  let writable = false;
  let revision = 0;
  let confirmed = -1;
  let generation = 0;
  let failureReason: string | null = null;
  const acknowledged = new Set<number>();

  function state(): SaveState {
    const online = provider?.synced && provider.channel?.state === "joined";
    const saveStatus = confirmed >= revision ? "saved"
      : failureReason ? "failed"
        : online && writable ? "saving"
          : revision > 0 ? "unsaved" : "not-saved";
    return { saveStatus, saveError: failureReason,
      hasUnsavedChanges: confirmed < revision && (revision > 0 || Boolean(online && writable)) };
  }

  function show() { render(state()); }

  function save(update: Uint8Array, capturedRevision: number, fullState = false) {
    const channel = provider?.channel;
    if (!writable || !provider?.synced || channel?.state !== "joined") return show();
    const capturedGeneration = generation;
    const current = () => capturedGeneration === generation && provider?.channel === channel;
    const failure = ({ reason = "save_unconfirmed" } = {}) => {
      if (current() && capturedRevision > confirmed) {
        failureReason = reason;
        show();
      }
    };
    channel.push("save_update", update.slice().buffer, 10_000)
      .receive("ok", ({ saved }) => {
        if (!current()) return;
        if (!saved) return failure();
        if (fullState) confirmed = Math.max(confirmed, capturedRevision);
        else acknowledged.add(capturedRevision);
        while (acknowledged.delete(confirmed + 1)) confirmed++;
        for (const item of acknowledged) if (item <= confirmed) acknowledged.delete(item);
        if (confirmed >= revision) failureReason = null;
        show();
      })
      .receive("error", failure)
      .receive("timeout", () => failure({ reason: "timeout" }));
    show();
  }

  function updated(update: Uint8Array, origin: unknown) {
    if (!provider || origin !== provider) {
      revision++;
      save(update, revision);
    }
  }

  function synced(value: boolean) {
    generation++;
    acknowledged.clear();
    failureReason = null;
    if (value) save(Y.encodeStateAsUpdate(doc), revision, true);
    show();
  }

  function detach() {
    generation++;
    provider?.off("sync", synced);
    provider = undefined;
    acknowledged.clear();
    failureReason = null;
  }

  doc.on("update", updated);
  return {
    get state() { return state(); },
    attach(next: PhoenixChannelProvider, canWrite: boolean) {
      detach();
      provider = next;
      writable = canWrite;
      provider.on("sync", synced);
    },
    detach,
    destroy() {
      detach();
      doc.off("update", updated);
    },
  };
}
