import type { Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";

export type RoomRole = "owner" | "editor" | "viewer";
export interface RoomAccess {
  token: string;
  userId: string;
  role: RoomRole;
}
export interface AccessRequest {
  roomId: string;
  /** Aborted when this connection attempt is cancelled or times out. */
  signal: AbortSignal;
}
export interface RoomOptions {
  roomId: string;
  /** Authenticated account ID. Changing accounts requires a fresh instance. */
  userId: string;
  /** HTTP(S) origin; defaults to location.origin in the browser. */
  serverUrl?: string;
  /** Fresh access for every attempt. Defaults to Synixir's session/CSRF API. */
  getAccess?: (request: AccessRequest) => Promise<RoomAccess>;
}
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error" | "destroyed";
export type SaveStatus = "not-saved" | "saving" | "saved" | "unsaved" | "failed" | "view-only";
export interface RoomState {
  readonly connection: ConnectionState;
  readonly role: RoomRole | null;
  readonly readOnly: boolean;
  readonly saveStatus: SaveStatus;
  readonly hasUnsavedChanges: boolean;
  readonly error: SynixirError | null;
  readonly saveError: string | null;
}
export class SynixirError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, options?: { retryable?: boolean });
}
export class SynixirRoom {
  constructor(options: RoomOptions);
  readonly doc: Doc;
  readonly awareness: Awareness;
  readonly state: RoomState;
  /** Immediately receives the current immutable state. Returns an unsubscribe function. */
  subscribe(listener: (state: RoomState) => void): () => void;
  /** Resolves on synchronization, separately from durable save confirmation. */
  connect(): Promise<void>;
  /** Cancels pending work and waits for socket shutdown; retains the document. */
  disconnect(): Promise<void>;
  /** Terminal and idempotent. Destroys the owned document and awareness. */
  destroy(): Promise<void>;
}
