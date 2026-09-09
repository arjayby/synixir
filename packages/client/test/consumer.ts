import { SynixirRoom, SynixirError, type RoomState, type RoomAccess } from "@synixir/client";
import { applyUpdate, type Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";

const room = new SynixirRoom({ roomId: "notes", userId: "account-id", serverUrl: "https://example.com",
  getAccess: async ({ roomId, signal }): Promise<RoomAccess> => {
    signal.throwIfAborted();
    return { token: roomId, userId: "account-id", role: "editor" };
  },
});
const doc: Doc = room.doc;
const awareness: Awareness = room.awareness;
applyUpdate(doc, new Uint8Array([0, 0]));
awareness.setLocalStateField("user", { name: "A" });
const unsubscribe: () => void = room.subscribe((state: RoomState) => {
  const writable: boolean = !state.readOnly;
  const error: SynixirError | null = state.error;
  console.log(writable, error?.code, state.saveStatus);
});
const operation: Promise<void> = room.connect();
void operation.catch((error: SynixirError) => console.log(error.retryable));
void room.disconnect();
unsubscribe();
void room.destroy();
// @ts-expect-error An account ID is required.
new SynixirRoom({ roomId: "notes" });
// @ts-expect-error Server roles have a closed vocabulary.
const invalid: RoomAccess = { token: "x", userId: "id", role: "admin" };
// @ts-expect-error Consumers cannot replace a room's document.
room.doc = doc;
// @ts-expect-error State snapshots are immutable.
room.state.connection = "connected";
void invalid;
