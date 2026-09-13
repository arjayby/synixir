<h1 align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="docs/assets/synixir-header-dark-static.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/synixir-header-light-static.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/synixir-header-dark.svg">
    <img src="docs/assets/synixir-header-light.svg" alt="Synixir" width="800">
  </picture>
</h1>

Synixir is an Elixir/Phoenix backend for collaborative Yjs documents and shared
application state. It syncs changes through Phoenix Channels, uses Yex to work
with Yjs on the server, and saves document updates in PostgreSQL.

Connect your own interface with the JavaScript SDK, or try the included
playground to edit text, draw, and organize work together.

## What can you build?

The playground includes working examples you can use as a starting point:

| Use case | Included examples |
|---|---|
| Write together | CodeMirror text editor and Tiptap rich-text editor |
| Plan projects | [Kanban board](examples/collaboration/kanban/README.md) and [flowchart builder](examples/collaboration/flowchart/README.md) |
| Draw together | [Excalidraw whiteboard](examples/collaboration/whiteboard/README.md) with shared cursors |
| Edit structured data | [Multiplayer form](examples/collaboration/multiplayer-form/README.md) and [collaborative table](examples/collaboration/table/README.md) |

All examples share room access, presence, and persistence. Each keeps its own
content within the room's Yjs document. The [playground guide](examples/collaboration/README.md)
explains the libraries and shared data types.

## What's included?

- Concurrent editing and reconnect support for Yjs text and shared state.
- Durable saves, storage snapshots, compaction, and recovery after server crashes.
- Live participant presence and cursors, with local undo in the playground.
- Accounts, expiring sessions, and owner/editor/viewer room permissions.
- A JavaScript SDK with TypeScript declarations and save status that confirms
  database persistence.

## Try it locally

Start Docker or OrbStack. You'll need Git, Docker Compose v2, OpenSSL, and
Elixir 1.18+ with Erlang/OTP 27+. The pinned versions are in
[.tool-versions](.tool-versions). Docker builds the backend and browser examples;
the staging scripts need no Mix dependencies.

For a first installation:

```sh
git clone https://github.com/arjayby/synixir.git
cd synixir
elixir scripts/staging.exs init
elixir scripts/staging.exs build
elixir scripts/staging.exs up
```

Open [https://localhost:8443](https://localhost:8443) and accept the local
self-signed certificate. Create an account and a room, then open the same room
in a second tab. Type in either tab to see changes appear in both. Use the example
menu to try a board, drawing, or form in that room.

To collaborate with someone else, have them create an account, then grant their
username access through **Manage access**. Sharing a room URL alone grants no access.
Wait for **Saved** before closing a tab with edits.

Stop with `elixir scripts/staging.exs stop`; start again with
`elixir scripts/staging.exs up`. Run `init` only once and retain the private
`.local/staging` configuration with its database volume. See the
[staging guide](docs/deployment.md) for certificate renewal, backups, and upgrades.

## Connect your app

Use `@synixir/client` to connect an authorized room and pass its `doc` and
`awareness` to your Yjs binding. Use `Y.Text` for shared text or `Y.Map` for
application state such as settings and board data.

The SDK is available in this repository and is not published to npm. The
[SDK guide](packages/client/README.md) covers installing a local tarball, account
access, editor integration, save states, and cleanup.

## Documentation

- [Development and internals](docs/development.md): local backend setup, permissions, storage, and checks.
- [Client SDK](packages/client/README.md): installation and integration examples.
- [Playground](examples/collaboration/README.md): example libraries and frontend development.
- [Local Docker staging](docs/deployment.md): HTTPS setup, release checks, and replacement.
- [Operations](docs/operations.md): quotas, health checks, metrics, alerts, and backup restoration.

## Current status

Local Docker HTTPS staging, operations tools, and backup restoration are
implemented. [CI](.github/workflows/ci.yml) builds the release and runs an HTTPS
pilot that checks collaboration, app replacement, and database recovery.

- Runs on one application node, with downtime during upgrades.
- Unsaved offline edits live only in the open tab. Closing or reloading it loses
  unconfirmed changes.
- Public hosting, external alert delivery, and off-machine backup scheduling
  require separate setup.
