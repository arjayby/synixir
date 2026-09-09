# Storage and document lifecycle findings

Investigated on 2026-09-09 against the pinned packages: Yex 0.10.5, yrs 0.25.0, Yjs 13.6.32, and y-phoenix-channel 0.3.0. This note records the evidence behind step 7's persistence and transport choices.

## A snapshot must retain pending updates

`Yex.encode_state_as_update/1` is unsafe as the sole source for a durable snapshot in this version. Despite its name, the native implementation calls `txn.encode_diff_v1`. Yrs documents that method as excluding pending updates. Its separate `encode_state_as_update_v1` method merges both pending structs and pending delete sets, but Yex does not call that method. These are updates whose dependencies have not arrived yet; the visible text and the integrated state cannot reconstruct them. Sources: [Yex native encoding](https://github.com/satoren/y_ex/blob/v0.10.5/native/yex/src/doc.rs#L423), [yrs transaction encoding](https://github.com/y-crdt/y-crdt/blob/v0.25.0/yrs/src/transaction.rs#L58), [yrs pending-state merge](https://github.com/y-crdt/y-crdt/blob/v0.25.0/yrs/src/transaction.rs#L374).

`Yex.merge_updates/1` is available in the pinned package. It delegates to `yrs::merge_updates_v1`, which decodes update bytes, merges their structs and delete sets, and encodes the result without applying those updates to a document. The merge algorithm handles structs that cannot yet integrate. A snapshot formed by merging the previous snapshot and committed raw updates therefore retains missing dependencies and deletions. Sources: [Yex merge API](https://github.com/satoren/y_ex/blob/v0.10.5/lib/y_ex.ex#L135), [native merge](https://github.com/satoren/y_ex/blob/v0.10.5/native/yex/src/doc.rs#L397), [yrs binary merge](https://github.com/y-crdt/y-crdt/blob/v0.25.0/yrs/src/alt.rs#L9), [struct and delete-set merge](https://github.com/y-crdt/y-crdt/blob/v0.25.0/yrs/src/update.rs#L622).

This is update-log compaction. It removes duplicate encoding and reduces the number of rows to replay. It does not garbage-collect deleted content or promise a bounded document history. Yjs explicitly distinguishes binary merging from garbage collection. Source: [Yjs alternative update API](https://docs.yjs.dev/api/document-updates#alternative-update-api).

### Executed compatibility probe

A small probe generated V1 updates with the installed Yjs 13.6.32 package and loaded them with the installed Yex 0.10.5 NIF. It ran without starting Synixir or connecting to PostgreSQL.

The base update inserts `abc` with client ID 1. Later updates append `!` with the same client, delete `b`, and append `?` with client ID 2 after that client has received the base. Each later update was applied to an empty document before its missing base update. The probe saved either the document encoding or the merged raw update, restored that into another empty document, and finally supplied the base.

| Update waiting for its base | Yex document encoding, then base | Yex merged raw bytes, then base | Yjs document encoding, then base |
| --- | --- | --- | --- |
| Same-client insert | `abc` | `abc!` | `abc!` |
| Deletion | `abc` | `ac` | `ac` |
| Cross-client insert | `abc` | `abc?` | `abc?` |

Yex's document encoding was the two-byte empty update in all three cases. Merging the raw update retained 10, 6, and 10 bytes respectively. Repeatedly merging a prior snapshot, later-arriving base, and duplicate updates restored the expected `ac!?`.

Yjs's different result is explained by its `encodeStateAsUpdateV2` implementation, which adds both `pendingDs` and `pendingStructs` before merging. The V1 convenience API calls that implementation with a V1 encoder. Source: [Yjs state encoding](https://github.com/yjs/yjs/blob/v13.6.32/src/utils/encoding.js#L522).

Regression tests should construct these delayed-dependency cases deliberately. Testing only a document that has already integrated every update will miss the loss.

## Atomic compaction and consistent restoration

The following design follows from PostgreSQL's transaction and isolation guarantees:

1. Serialize compaction for a room. Read its previous snapshot and a selected prefix of raw rows.
2. Merge those exact bytes and record the covered update ID.
3. Replace the snapshot and delete only the covered rows in the same transaction.
4. Return success only after that transaction commits. On any failure, keep the old snapshot and log intact.

PostgreSQL transactions make the snapshot replacement and row deletion visible together and roll back both on failure. Source: [PostgreSQL 17 transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html).

Restoration also needs a consistent view. Two independent reads under the default Read Committed isolation can read an old snapshot, then see the log after another transaction compacted and deleted it. Restore must use one database snapshot, such as a Repeatable Read transaction, or take the same room lock as compaction. Concurrent compactors need serialization too. A transaction-scoped advisory lock is one available option and releases automatically when the transaction ends. Sources: [PostgreSQL 17 isolation](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED), [advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).

The original single document-process owner already orders room writes. Preserve that ownership and the existing apply, commit raw bytes, acknowledge order. A separate background compactor must coordinate its snapshot/log reads with restore and other compactors. Do not assume a transaction around two reads alone supplies a stable snapshot at Read Committed.

## Chunking must cover every sync direction

The installed y-phoenix-channel 0.3.0 implementation sends complete binary buffers in these places:

- Its join handshake pushes `yjs_sync` containing a state vector.
- A received `yjs` message can generate a complete sync response that it pushes back as `yjs`.
- Local document updates and throttled merged updates push `yjs`.
- Awareness uses the same `yjs` event.

The package exposes a `channel` option and uses the supplied channel's `push`, `on`, `joinPush`, `state`, `onError`, `onClose`, and `leave` methods. It sets `synced` after decoding a complete sync-step-2 message. These findings come from the published package's `dist/y-phoenix-channel.js` and `.d.ts`. Source: [publisher's versioned npm package](https://registry.npmjs.org/y-phoenix-channel/-/y-phoenix-channel-0.3.0.tgz).

A channel adapter can therefore fragment outgoing buffers and reassemble incoming buffers without replacing the provider. That is an implementation choice inferred from the package API. The adapter must preserve the Phoenix Push callback contract used by `save-status.js`. It should deliver complete protocol messages to the provider, including the initial sync response, so the provider cannot declare synchronization complete after only a fragment.

Server chunking must cover both direct sync replies and forwarded document broadcasts. Client chunking must cover the provider's automatic sync response as well as `save_update`. Changing only the explicit full-state save leaves other large-message paths broken.

Application-level byte fragments are transport pieces, not independently valid Yjs updates. Validate and apply the assembled bytes once. Intermediate fragment acknowledgements must not report `saved: true`. The final acknowledgement must follow the existing raw-update database commit. A disconnect before completion must discard that incomplete transfer or allow a checked retry without claiming durability.

Bound fragment size, assembled transfer size, transfer lifetime, and concurrent transfers. Count fragments against the channel message budget and send with backpressure. Reject malformed sequence numbers and conflicting transfer metadata before allocating large buffers. Generation changes must invalidate unfinished transfers and stale save acknowledgements.

A total transfer-size limit also limits the full state that can reconnect in one transfer. It is a separate limit from the 1 MiB individual message cap and must be documented. Compaction cannot guarantee that a long-lived document's encoded state stays below either limit.

## Idle room behavior

The pinned `SharedDoc` tracks observer processes, monitors them, and removes their ephemeral awareness on `DOWN`. Its `auto_exit` mode stops immediately when the last observer goes away. A configurable idle grace period requires explicit room timer handling, with stale timers ignored after new activity or a new observer. Source: [Yex observer and exit handling](https://github.com/satoren/y_ex/blob/v0.10.5/lib/protocols/shared_doc.ex#L144).

Idle eviction must not depend on a successful final snapshot. Every acknowledged update is already durable. If optional compaction fails, preserving the raw log and releasing the idle worker is safe; discarding any acknowledged raw rows is not. A later open must restore snapshot plus tail and refuse the join on a restore failure.
