# @synixir/client

A browser SDK for Synixir rooms. It owns the Yjs document, awareness, authorized
connection, chunk transfers, durable save tracking, and reconnect recovery.
It works with any Yjs binding; the repository's CodeMirror example uses this API.

This package is in development and is not published to npm. From the repository
root, run `npm ci`, then `npm pack --workspace @synixir/client`. Install that
tarball in your application along with `yjs@^13.6.32`:

```sh
npm install /path/to/synixir-client-0.1.0.tgz yjs@^13.6.32
```

The SDK is written in strict TypeScript and ships compiled ESM JavaScript with
generated declarations. Use it from TypeScript or JavaScript with Next.js, Vite,
or another browser ESM bundler.
Importing the module is safe without browser globals; connecting requires browser
WebSocket/fetch APIs. Outside the browser, supply `serverUrl` when constructing a
room. Yjs is a shared peer dependency, so applications and editor bindings use
one copy. Phoenix and the channel provider are private implementation details.

## Connect an editor

Sign in and create or join a room through your application's account UI first.
The default access callback uses Synixir's cookie session API. Serve `/api` and
`/socket` through the frontend origin, as the repository's Next.js example does.

```js
import { SynixirRoom } from "@synixir/client";

const room = new SynixirRoom({
  roomId: "design-notes",
  userId: signedInUser.id,
});

// Give these to your Yjs editor binding.
const text = room.doc.getText("content");
const awareness = room.awareness;
awareness.setLocalStateField("user", { name: signedInUser.username });

const unsubscribe = room.subscribe(state => {
  editor.setReadOnly(state.readOnly);
  renderStatus(state.connection, state.saveStatus, state.saveError);
});

try {
  await room.connect(); // Initial document synchronization has completed.
} catch (error) {
  showConnectionError(error.code);
}
// Wait for state.saveStatus === "saved" before treating edits as durable.

// Before unmounting: remove your editor binding/observers, then dispose the room.
unsubscribe();
editor.destroy();
await room.destroy();
```

`doc` and `awareness` belong to the SDK. Do not replace them or destroy them
independently. Remove application observers and bindings before `destroy()`.
Each instance represents one room and one account. Create a fresh instance when
either changes. Documents and undo history are not shared between instances.

## Options and lifecycle

| API | Behavior |
|---|---|
| `new SynixirRoom({roomId, userId, serverUrl?, getAccess?})` | Starts disconnected with a fresh document. `roomId` follows the server's 1–128 character rules. `userId` is the authenticated account ID. |
| `serverUrl` | HTTP(S) origin, defaulting to `location.origin`. Paths, credentials, queries, and fragments are rejected. The socket path is `/socket`. |
| `doc`, `awareness` | SDK-owned Yjs integration objects. Use any shared type name appropriate for your application. |
| `state` | Current frozen snapshot. No tokens or document content appear in it. |
| `subscribe(listener)` | Calls immediately, then on state changes. Returns an unsubscribe function. Rendering exceptions are reported to the host without stopping the SDK. |
| `connect()` | Returns a promise for this synchronization attempt. Overlapping calls share that promise. Already connected calls resolve immediately. Rejections are `SynixirError` with `code` and `retryable`. |
| `disconnect()` | Cancels access lookup, connection attempts, and automatic retries. Waits for socket shutdown. Retains document, awareness's local state, and offline edits. A later connect requests fresh access. |
| `destroy()` | Terminal and idempotent. Cancels work, destroys document and awareness, emits the final `destroyed` state, and clears subscriptions. Its promise waits for socket shutdown. Future connect calls reject with `destroyed`. |

Network errors and access endpoint 429/5xx responses retry automatically, starting
at 250 ms and backing off to five seconds. Each attempt obtains a fresh grant
and channel after the previous socket closes. `connect()` can reject while this
recovery continues; observe `state.connection`. Call `disconnect()` to stop it.
Access lookup times out after ten seconds, joins after ten seconds, and the
initial sync after 45 seconds. A server rejection or invalid sync stops retries
so the application can explain the failure and offer an explicit retry.

Manual disconnect cancels an unfinished connect with `disconnected`; destruction
cancels it with `destroyed`. Cancellation aborts the access callback's signal.
The SDK ignores callbacks and replies belonging to cancelled attempts, even if a
custom callback ignores cancellation.

## State and durability

| Field | Values / meaning |
|---|---|
| `connection` | `disconnected`, `connecting`, `connected`, `reconnecting`, `error`, `destroyed` |
| `role` | `null` before access, then `owner`, `editor`, or `viewer` |
| `readOnly` | True before access, for viewers, after access/account changes, and after destruction. Honor this in editor controls and commands. Known owners/editors can edit offline. |
| `saveStatus` | `not-saved`, `saving`, `saved`, `unsaved`, `failed`, `view-only` |
| `hasUnsavedChanges` | Whether edits or a pending initial save lack confirmation. Useful for an unload prompt. Always false for viewers, who never submit saves. |
| `error` | Last connection error or `null`. `error.code` describes it; `error.retryable` says whether recovery can retry it. |
| `saveError` | Server save reason, `timeout`, or `null`. Independent of connection status. |

`connected` means the document sync handshake completed. `saved` means the
server acknowledged persistence covering every local revision, including offline
deletions. Later acknowledgements cannot cover gaps in earlier ones. A full
state save on each sync confirms retained offline changes. Old-channel and late
timed-out replies cannot confirm newer edits.

A failed or missing save reply leaves the draft unconfirmed, even if the server
committed it. Disconnect and connect to retry and obtain a fresh acknowledgement.
Duplicate updates are safe. The SDK keeps the server's negotiated message and
transfer bounds, queues large transfers with backpressure, and acknowledges only
completed uploads. A state beyond the server's transfer cap requires a smaller
document or a server configuration change.

`saveError: "storage_quota"` means the room has reached its retained-byte limit.
The SDK keeps the draft unconfirmed. Keep the page open or copy the draft, ask
an operator to compact retained updates or increase the limit, then reconnect.
Deleting text also creates CRDT history and does not necessarily free storage.
Join errors `node_channel_quota`, `room_channel_quota`, `account_channel_quota`
and `document_quota` stop that connection attempt. Call `connect()` after capacity
is available; the instance retains local edits. See the
[operations guide](../../docs/operations.md) for quota scope and recovery.

There is no disk/IndexedDB persistence. Closing or reloading the page loses
unconfirmed changes. The SDK never installs unload handlers or prompts; the
application decides how to warn and when to discard a draft.

## Access and account changes

The default callback fetches `/api/session` to verify `userId` and obtain fresh
CSRF state, then posts `/api/rooms/:roomId/token`. Cookies use `same-origin`
credentials; tokens remain in memory. It does this on every reconnect, including
automatic recovery. The token response's `expires_at` is the session expiration,
not the room grant's lifetime. It is not used as a token refresh timer.

For another trusted access integration, supply a callback:

```js
import { SynixirRoom, SynixirError } from "@synixir/client";

const room = new SynixirRoom({
  roomId: "design-notes",
  userId: signedInUser.id,
  serverUrl: "https://collaboration.example.com",
  getAccess: async ({ roomId, signal }) => {
    const response = await fetch(`/my-room-access/${encodeURIComponent(roomId)}`, { signal });
    if (!response.ok) throw new SynixirError("access_denied");
    // Your trusted endpoint returns {token, userId, role} for this account/room.
    return response.json();
  },
});
```

The backend must accept the frontend's WebSocket origin. Cross-origin cookie/CORS
configuration is not added by the SDK. A plain callback exception is treated as
a retryable network failure; use `SynixirError(code, {retryable})` for deliberate
failure handling. Never mint grants or choose authority in browser code.

`account_changed` or `access_changed` freezes the instance and disables further
connections. This happens when the authenticated account differs, a fresh grant
has a different role, or the channel announces revocation. Keep a same-account
draft available to copy, then destroy the room and obtain current permissions
for a fresh instance. On logout/account switch, your application must immediately
clear its bindings and destroy the old room. The SDK cannot detect external
cookie changes while offline. The example also broadcasts a session-change
notification across tabs and clears documents when account changes are detected.

Viewers receive document updates and can publish awareness. Their transport blocks
Yjs document writes and automatic saves even if application code mutates the
exposed document. Such changes are local only and require a fresh instance to
discard. Server authorization remains authoritative. Awareness is ephemeral,
client-supplied data; it never proves identity or permissions. Reconnect advances
its local clock so peers accept returning presence. Browser broadcast-channel
sync stays disabled so document exchange always passes server authorization.

## Checks

From the repository root:

```sh
npm ci
npm test
npm run test:package
npm run build
npm run test:browser
```

The package check installs a real tarball into a temporary consumer and checks
ESM imports, shared Yjs identity, TypeScript NodeNext/bundler resolution, package
exports, and a Vite build. Browser tests use the package through both CodeMirror
and a small shared-settings example against the real server and PostgreSQL.
Run browser tests separately from ExUnit because both use `synixir_test`.
