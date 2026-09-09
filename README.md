# Synixir

Synixir is an Elixir/Phoenix collaboration backend in early development.
It connects browser Yjs documents to supervised Yex processes through Phoenix
Channels. Each room has its own document process backed by a PostgreSQL update
log, and clients need a signed room access token to join. The browser example
provides a shared plain text editor with live cursors, participant information,
and recovery after a server crash.

This implementation runs on one Phoenix node. Account authentication and a
public client SDK are still planned.

## Local setup

- Elixir 1.18.3 and Erlang/OTP 27.3.3, pinned in `.tool-versions` for asdf.
- Hex and Rebar, installed once with `mix local.hex --force` and
  `mix local.rebar --force`.
- Docker with Compose v2, through OrbStack or Docker Desktop.

With the asdf Erlang and Elixir plugins installed, `asdf install` installs the
versions in `.tool-versions`. Run the commands below from the project directory.

1. Start OrbStack or Docker Desktop. On macOS with OrbStack, use `orbctl start`.
2. Start PostgreSQL and wait for it to accept connections:

   ```sh
   docker compose up -d --wait db
   ```

   [compose.yaml](compose.yaml) runs PostgreSQL 17.11 at `localhost:5432` with
   username `postgres` and password `postgres`. These are local development
   credentials matching `config/dev.exs` and `config/test.exs`.

3. Fetch dependencies and create the development database:

   ```sh
   mix setup
   ```

   This creates `synixir_dev` and its document update table. For an existing
   checkout, run `mix ecto.migrate` after pulling new migrations.

4. Run the checks below, then start Phoenix:

   ```sh
   mix phx.server
   ```

The server listens at [localhost:4000](http://localhost:4000), with a collaboration
WebSocket at `/socket/websocket`. There is no homepage, so `/` returns 404.
Use `iex -S mix phx.server` for an interactive shell.

Use `docker compose ps` to check PostgreSQL and `docker compose logs db` to read
its logs. Stop it with `docker compose stop db`; start it again with the command
above. Database files live in the `synixir_postgres_data` Docker volume and
survive container removal with `docker compose down`.

If another PostgreSQL server already uses port 5432, either use that server and
skip Compose, or stop it before starting this container. When using your own
server, adjust `config/dev.exs` and `config/test.exs` to match its credentials.
The configured role must be able to create databases.

## Try the collaboration example

The browser example uses Node.js 24.12.0, pinned in
`examples/collaboration/.nvmrc`. Complete local setup above first. Restart
Phoenix after updating the application's supervision tree or configuration.

In a second terminal:

```sh
cd examples/collaboration
nvm install
nvm use
npm ci
npm run dev
```

If you manage Node.js another way, install the pinned version and skip the two
`nvm` commands. Open [127.0.0.1:5173](http://127.0.0.1:5173) in two tabs.
Both start in room `demo`. The example automatically requests a local demo
token for a random user ID in each tab.

1. Wait for both tabs to show **Connected**.
2. Type directly in the document. Both tabs should show the edits and list each
   other under **In this room**. Move the cursor or select text to see the other
   participant's colored caret and selection. Hover over a caret to see its name.
3. Try selecting, replacing, deleting, and pasting text. **Undo** and **Redo**
   affect your own edits, including through Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z.
4. Click **Disconnect** in both tabs, then type different text in each.
5. Click **Connect** in both tabs. Both edits should appear in the same order
   in each tab. Either ordering of simultaneous inserts is valid.
6. Wait for **Saved**, close both tabs, restart Phoenix, and open the same room
   in a new tab. The saved text should be restored from PostgreSQL.
7. Enter another **Room ID** and click **Open room**. That room should have its
   own document. Open the same URL in another tab to collaborate in that room.

Room IDs are case-sensitive, with 1 to 128 ASCII letters, digits, underscores
or hyphens, starting with a letter or digit. For example,
[`?room=design-notes`](http://127.0.0.1:5173/?room=design-notes) selects a room.
Opening another room navigates to a new page. Reconnect and wait for **Saved**
before switching if you want to keep local edits. The page asks before leaving
with unconfirmed edits when the browser supports an unload prompt. This is a
reminder, not offline storage. Keep the tab open until the edits are saved.

The editor uses [CodeMirror 6](https://codemirror.net/) and
[`y-codemirror.next`](https://github.com/yjs/y-codemirror.next/tree/v0.3.6) to
bind editing operations to the existing `doc.getText("content")`. Existing saved
documents remain compatible. Its Yjs undo manager tracks local editor changes
and leaves remote edits intact. Undo history lasts for this page visit only.
The example uses
[`y-phoenix-channel`](https://github.com/satoren/y-phoenix-channel/tree/main/npm/y-phoenix-channel)
to exchange Yjs binary sync messages with `SynixirWeb.DocumentChannel` on
`document:<room_id>`. Browser broadcast-channel sync is disabled so updates
travel through Phoenix.

Each visit gets a generated guest name and cursor color. The participant list
counts connected browser sessions, not accounts. Names and cursor positions are
temporary, client-supplied awareness data; they do not establish identity or room
permissions. Awareness is scoped to the room, removed when the channel leaves,
and announced again after reconnecting. Focusing another control clears the
local cursor. Nothing in awareness is written to the document update log.

**Connecting** means the initial sync is in progress. **Connected** means the
channel has joined and synced. **Reconnecting** appears after a connection is
lost, while **Disconnected** means you clicked Disconnect. Editing remains
available offline, and its save status reports any unconfirmed changes.

## Room ownership and access

`Synixir.Documents.open/1` finds or starts a room's `Synixir.Documents.Document`
process, using Yex with UTF-16 offsets matching JavaScript. A unique Registry name prevents
concurrent callers from creating separate owners for the same room. A
DynamicSupervisor supervises the document processes. If the Registry fails,
the document supervisor also restarts so documents cannot outlive their lookup
entries. Ownership is local to one Phoenix node.

`SynixirWeb.DocumentChannel` verifies a room token before opening or observing
the document. A grant allows reading and editing one room as its signed user
ID. Missing, invalid, expired, or wrong-room tokens return an `unauthorized`
join error. An unsigned `user_id` in the join payload cannot change identity.

Trusted server code issues tokens after checking the user's room permissions:

```elixir
{:ok, token} = Synixir.RoomAccess.issue("design-notes", "user-123")
```

Pass that token as a channel join parameter. With the browser provider:

```js
new PhoenixChannelProvider(socket, `document:${roomId}`, doc, {
  params: { token },
  disableBc: true,
});
```

Tokens use [`Phoenix.Token`](https://phoenix.hexdocs.pm/Phoenix.Token.html)
and the endpoint's secret key base. They are bearer credentials, signed but
not encrypted, and valid for new joins for 15 minutes. Verification happens on
every join, including reconnects. An existing joined channel remains authorized
until it leaves or disconnects; expiry does not revoke an active session. There
is no account system, membership database, role model, or revocation mechanism
yet. Keep token issuance in trusted server code and use opaque user IDs.
Phoenix filters `token` parameters from its logs.

For local testing only, `POST /api/demo/room-token` accepts `room_id` and
`user_id` and returns a token without checking permissions. The browser example
calls it on startup and whenever **Connect** is clicked. The response uses
`Cache-Control: no-store`. This route is compiled only when
`:collaboration_demo` is enabled and also checks that setting at runtime.
Development and test enable it; production defaults to disabled. Do not enable
this unrestricted issuer in production. The document socket itself remains
available with signed-token authorization.

## Persistence and save acknowledgements

The `document_updates` table stores incoming Yjs v1 update bytes, indexed by
room and insertion order. A SHA-256 digest makes repeated delivery of identical
bytes within a room a no-op in PostgreSQL. Room startup replays the log before
accepting joins, and normal Yjs state-vector sync supplies missing changes to
reconnecting clients.

The room process validates and applies an update, commits its incoming bytes,
then acknowledges the request and broadcasts the change. It stores incoming
bytes even when Yex is waiting for a missing dependency. Saving only emitted
document changes would lose those pending updates on a crash. A failed database
write stops the modified in-memory process without a saved acknowledgement or
broadcast. A load failure refuses the join instead of serving an empty document.

`Synixir.Documents.Document` uses `Yex.DocServer` with synchronous requests for
this ordering. It reuses `Yex.Sync.SharedDoc` callbacks for observers and
awareness, but does not use its asynchronous update entry point or rely on a
shutdown hook to save data. Awareness remains temporary and is not stored.

The channel supports these messages:

| Event | Binary payload | Successful reply |
|---|---|---|
| `yjs` or `yjs_sync` | A Yjs v1 sync or awareness message | `{saved: true}` for committed updates; `{saved: false}` for handshake or awareness messages |
| `save_update` | A raw Yjs v1 document update | `{saved: true}` after the database write commits |

Replies use Phoenix's `ok` or `error` status. `yjs` pushes still carry the
standard binary sync messages expected by `y-phoenix-channel`. For example,
an explicit save request is:

```js
channel.push("save_update", update.slice().buffer)
  .receive("ok", ({ saved }) => { /* saved === true confirms durability */ })
  .receive("error", () => { /* retain local changes and retry */ })
  .receive("timeout", () => { /* outcome unknown; retrying is safe */ });
```

The example sends incremental updates through this save path and a full update
when it reconnects. Duplicate delivery through the standard provider is safe.
Its save tracker waits for acknowledgements covering every local edit, including
deletions, and ignores late replies from old connections. **Connected** reports
sync progress. **Saved** confirms database persistence; **Saving**, **Unsaved
changes**, and **Save failed** do not. A timeout may mean the write committed
but its reply was lost. Reconnect to retry and obtain confirmation.

## Document lifetime

Documents are created on demand and remain in memory after all clients leave.
After a document crash or server restart, the next join opens a process and
restores its committed updates. Channels attached to a failed process close so
clients can rejoin. Document processes use temporary supervision to avoid an
automatic restart loop during a database outage; other rooms keep running.

Use a new room ID for a fresh document. Restarting Phoenix no longer resets
saved content. Offline changes remain only in that tab until acknowledged as
saved; closing or reloading an offline tab loses unsent edits. Existing content
from the earlier memory-only implementation is not imported automatically.

The update log is append-only. Compaction, snapshots, retention, idle eviction,
and multi-node ownership are not implemented yet. Long-lived rooms will need
compaction to control log growth and recovery time.

Yex uses precompiled native binaries on supported platforms; the installed
Elixir/OTP versions were checked on Apple Silicon without Rust.

## Checks

```sh
MIX_ENV=test mix deps.get --check-locked
MIX_ENV=test mix compile --warnings-as-errors
mix format --check-formatted
mix test
```

`mix test` creates and migrates `synixir_test` before checking room ownership,
authorization, save acknowledgements, recovery of pending updates, and database
failure behavior. PostgreSQL is required. Test partitions append
`MIX_TEST_PARTITION` to the test database name.

Run the browser interoperability test separately after installing its Node.js
dependencies:

```sh
cd examples/collaboration
npx playwright install --only-shell chromium
npm test
npm run build
```

Playwright migrates the test database and starts its own Phoenix server on port
4010 and Vite on port 5174, then shuts them down. Those ports must be free;
your development servers can keep running on ports 4000 and 5173. Each test uses
unique room IDs so saved data from previous runs does not affect the assertions.

The browser tests check room isolation, typing and selection replacement,
multiline and Unicode edits, local undo/redo, remote selections following edits,
participant departure and reconnect, and cancelling navigation with unsaved
changes. They also check concurrent offline edits. The
durability test waits for **Saved**, closes all original clients, kills its
Phoenix process with `SIGKILL`, and recovers the text in a fresh browser context.
It also covers a Unicode deletion and offline edits across another restart.
This runs against real PostgreSQL commits, outside the ExUnit SQL sandbox.

The [CI workflow](.github/workflows/ci.yml) runs these checks on pull requests
and pushes to `main`. It uses the versions in `.tool-versions` and the same
PostgreSQL image as Compose. Each run gets a fresh database and runs the browser
test in Chromium. CI checks formatting without modifying files, installs
JavaScript dependencies from the lockfile, and fails if Elixir dependency
resolution would change `mix.lock`. GitHub runs the workflow once the file is
pushed as part of a pull request or to `main`.

Production runtime configuration is in `config/runtime.exs`. It reads
`DATABASE_URL` and `SECRET_KEY_BASE`, with optional `PHX_HOST`, `PORT`, and
`POOL_SIZE` settings. Production provisioning and deployment are not configured.

Generated with the [Phoenix 1.8.13 generator](https://phoenix.hexdocs.pm/1.8.13/Mix.Tasks.Phx.New.html),
using PostgreSQL and disabling HTML, assets, LiveDashboard, Gettext, and mailer
generation.
