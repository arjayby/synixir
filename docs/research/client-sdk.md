# Browser client SDK

Researched on 2026-09-09 against merged baseline `d3fdc99` and installed Phoenix 1.8.13, y-phoenix-channel 0.3.0, and Yjs 13.6.32. This is an implementation recommendation, not a published package contract.

## Package shape

Use a small ESM package with plain JavaScript sources and TypeScript declarations. The existing Vite application needs no framework or bundler migration. Keep CodeMirror, DOM rendering, account forms, and membership administration in consuming applications.

Suggested entry-point metadata:

```json
{
  "type": "module",
  "types": "./index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./src/index.js",
      "default": "./src/index.js"
    }
  },
  "files": ["src", "index.d.ts", "README.md"],
  "peerDependencies": {"yjs": "^13.6.32"}
}
```

`type` gives `.js` files ESM semantics, while `exports` defines the supported entry point and prevents ordinary package imports of internal modules. Put the `types` condition first and test declaration resolution through the package name. Sources: [Node package entry points](https://nodejs.org/api/packages.html#package-entry-points), [TypeScript export resolution](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports).

Pin Phoenix 1.8.13 and y-phoenix-channel 0.3.0 as implementation dependencies. Keep Yjs as a shared peer and pin 13.6.32 in development/tests. Do not bundle another Yjs copy: its source warns that duplicate imports break constructor checks. Declare `y-protocols` directly if public declarations import its `Awareness` type. Avoid exposing provider/Phoenix types, which would pull their typing requirements into every consumer. Sources: [Yjs duplicate-import check](https://github.com/yjs/yjs/blob/v13.6.32/src/index.js#L118), [provider package and declarations](https://registry.npmjs.org/y-phoenix-channel/-/y-phoenix-channel-0.3.0.tgz).

Use an explicit `files` allowlist and package README. The checkout has no root license file, so dependency licenses do not establish a license for the SDK. Publication remains outside this milestone. Source for package inclusion and metadata: [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

## Public contract

`SynixirRoom({roomId, userId, serverUrl?, getAccess?})` can own a fresh Y.Doc and awareness object. Expose those two integration objects, a state snapshot, subscription/unsubscription, and `connect`, `disconnect`, and `destroy`. Keep channel events and chunk receipts internal.

The default access function can use the existing session/CSRF endpoints. A custom `getAccess({roomId, signal})` should return the token, authenticated user ID, and role. Check that returned identity against the constructor's user ID. Abort it when its attempt becomes obsolete.

Define `connect()` completion as document synchronization readiness. Database durability is a separate save state. A completed provider handshake cannot stand in for a committed `save_update` acknowledgement. Preserve contiguous revision acknowledgements and generation checks from `save-status.js`; expose machine-readable states and leave display strings to the application.

`disconnect()` should preserve the document and offline draft and return a promise for transport shutdown. `destroy()` should be terminal and idempotent, clean up owned resources, and prevent later reconnects. Role change or access revocation should freeze transmission while allowing the same user's retained draft to be copied. A different account requires a new room instance. Read-only state also prevents automatic saves; exposing a writable Y.Doc does not replace server authorization.

## Lifecycle details that matter

- Fetch a fresh grant for each reconnect and create a fresh channel. The current `RoomAccess.issue/2` returns the session's `expires_at`, not the room token's 15-minute expiry. The chunk adapter also clones channel params, so mutating `provider.params.token` cannot update an existing channel's join params.
- Serialize reconnect behind Phoenix's `disconnect(callback)`. Its teardown waits asynchronously for buffered output and socket closure. The provider's `disconnect()` returns immediately, and its old channel callbacks change `synced`. Sources: [Phoenix disconnect and teardown](https://github.com/phoenixframework/phoenix/blob/v1.8.13/assets/js/phoenix/socket.js), [provider implementation](https://registry.npmjs.org/y-phoenix-channel/-/y-phoenix-channel-0.3.0.tgz).
- Deduplicate overlapping connects. Check an attempt generation after every await and inside every callback, including failed token fetches, join replies, sync errors, save replies, and chunk completion. Disconnect/destroy must settle pending operations and cancel retry timers. A late callback must not restart transport or change a newer attempt's state.
- Keep the chunk adapter's size limits, assembly timeout, backpressure, queue bounds, and final-acknowledgement semantics. Reset queued sends and partial receives on every channel generation change.
- Move reconnect presence reannouncement from `presence.js` into the SDK. Advancing the local awareness clock makes the returning state newer than the disconnect removal. Awareness manages its own renewal interval. Source: [Yjs awareness lifecycle and clocks](https://github.com/yjs/y-protocols/blob/v1.0.7/awareness.js).
- Provider destruction removes its listeners but does not destroy the awareness object or Y.Doc. Destroy the SDK-owned doc and awareness through a deliberate cleanup order. If caller-owned documents are supported later, state their ownership rules explicitly. Sources: [provider cleanup](https://registry.npmjs.org/y-phoenix-channel/-/y-phoenix-channel-0.3.0.tgz), [Y.Doc destruction](https://docs.yjs.dev/api/y.doc).
- Keep BroadcastChannel document exchange disabled. This preserves the existing server authorization boundary and prevents a second application from bypassing it through same-origin browser peers.

## Verify the distributable and the public interface

Use `npm pack --dry-run --json` to inspect included files, then create a real tarball with `npm pack --json --pack-destination <temporary-directory>`. Install that tarball and Yjs into an isolated consumer. A local directory dependency alone can hide missing files or duplicate dependency resolution. `npm pack` creates a tarball without publishing it. Source: [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/).

From that consumer, verify ESM import, TypeScript declarations under both NodeNext and bundler resolution, and a Vite production build. Confirm one Yjs instance resolves across SDK and application. Have the existing editor and a second small application consume the package by name.

Browser tests should operate through the SDK's documented API and visible consumer behavior. Preserve the existing durability, dropped/stale acknowledgement, large transfer, offline recovery, viewer, and revocation coverage. Add connect/disconnect overlap, destroy during pending access retrieval, fresh-grant reconnect, and absence of events or network restart after destruction. No global installation or publishing is needed for these checks.
