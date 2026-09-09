# Synixir

Synixir is an Elixir/Phoenix collaboration backend in early development.
It connects browser Yjs documents to supervised Yex processes through Phoenix
Channels. Each room has its own in-memory document, and clients need a signed
room access token to join. The browser example demonstrates room isolation and
concurrent text edits converging after reconnecting.

This implementation runs on one Phoenix node. PostgreSQL persistence, account
authentication, an editor UI, and a public client SDK are still planned.

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

   This creates `synixir_dev` and runs the empty migration and seed steps.

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
2. Enter text and click **Insert at start**. Both tabs should show it.
3. Click **Disconnect** in both tabs, then insert different text in each.
4. Click **Connect** in both tabs. Both edits should appear in the same order
   in each tab. Either ordering of simultaneous inserts is valid.
5. Close both tabs and open a new one. The backend should still have the text.
6. Enter another **Room ID** and click **Open room**. That room should have its
   own document. Open the same URL in another tab to collaborate in that room.

Room IDs are case-sensitive, with 1 to 128 ASCII letters, digits, underscores
or hyphens, starting with a letter or digit. For example,
[`?room=design-notes`](http://127.0.0.1:5173/?room=design-notes) selects a room.
Opening another room navigates to a new page; reconnect before switching if
you want to send local edits first.

The text area displays the shared result. The insert button provides a minimal
editing operation for this protocol check. The example uses
[`y-phoenix-channel`](https://github.com/satoren/y-phoenix-channel/tree/main/npm/y-phoenix-channel)
to exchange Yjs binary sync messages with `SynixirWeb.DocumentChannel` on
`document:<room_id>`. Browser broadcast-channel sync is disabled so updates
travel through Phoenix.

## Room ownership and access

`Synixir.Documents.open/1` finds or starts a room's
[`Yex.Sync.SharedDoc`](https://y-ex.hexdocs.pm/Yex.Sync.SharedDoc.html) process,
with UTF-16 offsets matching JavaScript. A unique Registry name prevents
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

## Document lifetime

Documents are created on demand and remain in memory after all clients leave.
They have no durable storage or idle eviction yet. A document crash loses its
state and supervision starts a new empty process; other rooms keep running.
Channels attached to the failed process close so clients can rejoin. A server
restart clears every room. To reset, close all example tabs and restart Phoenix.
An open client can send its local document back after a backend restart.
Offline edits live only
in that tab until they reach the backend; reloading an offline tab loses them.
**Connected** indicates sync has completed, not that PostgreSQL saved the text.

Yex uses precompiled native binaries on supported platforms; the installed
Elixir/OTP versions were checked on Apple Silicon without Rust.

## Checks

```sh
MIX_ENV=test mix deps.get --check-locked
MIX_ENV=test mix compile --warnings-as-errors
mix format --check-formatted
mix test
```

`mix test` creates and migrates `synixir_test` before checking document ownership,
room ID validation, channel authorization, the demo token endpoint, and JSON
errors. PostgreSQL is required. Test partitions append `MIX_TEST_PARTITION` to
the test database name.

Run the browser interoperability test separately after installing its Node.js
dependencies:

```sh
cd examples/collaboration
npx playwright install --only-shell chromium
npm test
npm run build
```

Playwright starts its own Phoenix server on port 4010 and Vite on port 5174,
then shuts them down. Those ports must be free; your development servers can
keep running on ports 4000 and 5173. The tests use isolated browser contexts,
check that separate rooms retain different text, make concurrent offline
inserts including Unicode, reconnect both clients, and verify the merged
document from a fresh client after the others close.

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
