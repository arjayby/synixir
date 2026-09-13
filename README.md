# Synixir

Synixir is an Elixir/Phoenix backend for collaborative Yjs documents. It
synchronizes shared text and application state through Phoenix Channels, stores
document updates in PostgreSQL, and shares live presence between participants.
Use the JavaScript SDK to connect your own application, or try the included
CodeMirror editor and shared settings examples.

Six more examples cover Kanban boards, whiteboards, rich-text editing, multiplayer
forms, flowchart builders, and collaborative tables. They share room permissions,
participant presence, undo, and recovery of saved state after a server crash.

- Durable document updates, snapshots, compaction, and recovery after a server crash.
- Live cursors and participant presence, with reconnect support and local undo.
- Accounts, expiring sessions, and owner/editor/viewer room permissions.
- A JavaScript SDK with TypeScript declarations, chunked transfers, and save
  status that confirms database persistence.
- Admission and storage quotas, health probes, protected Prometheus metrics,
  alert rules, load checks, and verified database backups.
- A Docker release with packaged browser assets, local HTTPS staging, and a CI
  pilot that exercises collaboration, app replacement, and database recovery.

Synixir currently runs on one Phoenix node, with downtime during upgrades.
Offline edits remain in the open tab until the server confirms a save. The
[`@synixir/client`](packages/client/README.md) package is available in this
repository and has not been published to npm. Local staging is implemented;
public hosting, external alert delivery, and off-machine backup scheduling
require separate setup.

| Guide | Contents |
|---|---|
| [Client SDK](packages/client/README.md) | Installation, connection and save states, and integration examples |
| [Local Docker staging](docs/deployment.md) | HTTPS setup, browser pilot, backups, replacement, and rollback |
| [Operations](docs/operations.md) | Quotas, health checks, metrics, alert rules, and load results |

## Try local Docker staging

Start Docker or OrbStack. Install Docker Compose v2, OpenSSL, and the Elixir and
Erlang versions in `.tool-versions`. The standalone scripts require Elixir 1.18+
and Erlang/OTP 27+ with no Mix dependencies. Run these commands from the repository
for the first setup:

```sh
elixir scripts/staging.exs init
elixir scripts/staging.exs build
elixir scripts/staging.exs up
```

Open [https://localhost:8443](https://localhost:8443), accept the local self-signed
certificate, and create an account and room. The release includes all browser
examples and uses its own PostgreSQL volume and private Prometheus collector.
Docker builds Elixir, Erlang, and the frontend inside the image.

For an existing installation, run `elixir scripts/staging.exs up` to start it.
Use `elixir scripts/staging.exs stop` to stop it while retaining the database.
Initialization runs only once; keep the private `.local/staging` configuration
with its database volume. The [staging runbook](docs/deployment.md) covers the
browser pilot, certificate renewal, backups, and upgrades.

## Local setup

Use this setup to develop the Phoenix backend and run the browser examples with
Next.js. It uses a separate database and ports from Docker staging.

- Elixir 1.18.3 and Erlang/OTP 27.3.3, pinned in `.tool-versions` for asdf.
- A C compiler and `make` for Argon2 password hashing, such as the Xcode Command
  Line Tools on macOS or build-essential on Ubuntu.
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

   This creates `synixir_dev` and its document, account, session, and membership tables. For an existing
   checkout, run `mix ecto.migrate` after pulling new migrations.

4. Run the checks below, then start Phoenix:

   ```sh
   mix phx.server
   ```

The server listens at [localhost:4000](http://localhost:4000), with a collaboration
WebSocket at `/socket/websocket`. Open the Next.js example below for the development
UI; the Docker release serves the packaged example at `/`. Use
`iex -S mix phx.server` for an interactive shell.

Use `docker compose ps` to check PostgreSQL and `docker compose logs db` to read
its logs. Stop it with `docker compose stop db`; start it again with the command
above. Database files live in the `synixir_postgres_data` Docker volume and
survive container removal with `docker compose down`.

If another PostgreSQL server already uses port 5432, either use that server and
skip Compose, or stop it before starting this container. When using your own
server, adjust `config/dev.exs` and `config/test.exs` to match its credentials.
The configured role must be able to create databases.

## Try the collaboration example

The examples use Next.js App Router, React, TypeScript, shadcn/ui, and Tailwind CSS.
Elixir/Phoenix remains the backend for accounts, permissions, persistence, and
WebSockets. The production build exports static pages for Phoenix to serve; no
Node server is needed in the release. See the [frontend guide](examples/collaboration/README.md).

The browser example uses Node.js 24.12.0, pinned in
`examples/collaboration/.nvmrc`. Complete local setup above first. Restart
Phoenix after updating the application's supervision tree or configuration.

In a second terminal:

```sh
cd examples/collaboration
nvm install
nvm use
cd ../..
npm ci
npm run dev --workspace synixir-collaboration-example
```

If you manage Node.js another way, install the pinned version and skip the two
`nvm` commands. Open [127.0.0.1:5173](http://127.0.0.1:5173) in two tabs.
Create an account with a public username and a password of 15–128 characters.
Create a room from **Your rooms**. Its creator becomes the first owner.

1. Open the room in another tab signed into the same account, or create another
   account in a separate browser profile.
2. To add a different account, enter its username under **Manage access** and
   choose **Editor**, **Viewer**, or **Owner**. Sharing the URL alone grants no
   access. The other account must already exist.
3. Owners and editors can type, select, replace, undo, and redo their own changes.
   Viewers receive the document and presence but cannot edit. Their status reads
   **View only** rather than claiming that they saved changes.
4. Disconnect an editor, make an offline edit, and reconnect. Wait for **Saved**
   before closing the tab. Offline edits survive only while the tab remains open.
5. Restart Phoenix and open the same room to restore its saved state.
6. Owners can change roles or remove members. Affected channels close and the
   example requires a reload to obtain current permissions. Copy any unsaved
   local draft before reloading. Revocation cannot erase text already received.

Signing out invalidates the current session, closes its room channels, and
clears document state in tabs sharing that browser session. Signing in as another
account creates fresh editors and documents. Browser storage carries only a
session-change notification, never credentials or document content.

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
The example consumes `@synixir/client` through its document, awareness, lifecycle
methods, and state subscription. The SDK uses
[`y-phoenix-channel`](https://github.com/satoren/y-phoenix-channel/tree/main/npm/y-phoenix-channel)
internally to exchange Yjs binary sync messages with `SynixirWeb.DocumentChannel`
on `document:<room_id>`. Browser broadcast-channel sync is disabled so updates
travel through Phoenix. The SDK owns fresh access grants, recovery, chunked
transfers, and save tracking; account forms and editor controls stay in the app.

See the [SDK interface and integration guide](packages/client/README.md) for
installation, connection and save states, cancellation, cleanup, and custom
access callbacks. `/sdk.html?room=<room_id>` provides a second small consumer
that synchronizes a title in a Y.Map without CodeMirror. It uses the same signed-in
account and room membership as the editor.

## Try the Kanban example

Open [127.0.0.1:5173/kanban.html](http://127.0.0.1:5173/kanban.html) with the same
development servers running. Sign in and create a board, or open an existing room.
The text editor and board link to each other and share account and room access.
The production build also includes `/kanban.html`.

- Add cards to Backlog, In progress, or Done. Open a card to edit its title,
  description, color, and status. Changes save as you type.
- Drag cards within or between columns using a mouse or touch. Focus a card's
  move handle and press Space to sort with the keyboard, then Escape to cancel.
  The status selector remains available for moving a card to another column.
- Open the same board in two tabs to see changes and card activity. To collaborate
  with another account, grant its username access under **Manage access**.
- Undo and redo affect this tab's local changes. Deleted cards can be restored
  with Undo. Viewers can inspect cards and publish presence, but cannot edit them.
- Offline changes remain in the open tab. Reconnect and wait for **Saved** before
  closing it. Saved boards recover through the existing PostgreSQL document log.

The [board model](examples/collaboration/kanban/model.ts) stores each card as a
nested Y.Map under `kanban:cards:v1`. Column and order are a single placement value,
so simultaneous moves converge to one location without duplicating a card.
Edits to different fields merge. Concurrent edits to the same title, description,
color, or placement resolve through Y.Map's conflict rules to one value; these
fields do not provide character-level text merging. A deletion wins over a
concurrent edit to that card. Fixed columns support card reordering through
`@dnd-kit/react`. Fractional ranks include stable card IDs to resolve ordering
ties without rewriting a column. Existing numeric orders remain readable.
See the [kanban integration notes](examples/collaboration/kanban/README.md).

The [shared React application](examples/collaboration/components/example-app.tsx) owns account,
room, connection, permission, and cleanup UI for all examples. Each editing
surface consumes the public SDK. Kanban's data uses a separate shared type, so
opening a text room as a board does not change its text content.

`npm test` includes model checks for concurrent creation, moves, deletion, and
local undo. The browser suite includes Kanban sync, presence, dragging, offline
recovery, server restart, permissions, room navigation, and mobile layout.

Run only the Kanban browser checks with:

```sh
npm test --workspace synixir-collaboration-example -- kanban.spec.ts
```

## Try the whiteboard example

Open [127.0.0.1:5173/whiteboard.html](http://127.0.0.1:5173/whiteboard.html) with the
same development servers running. Sign in and create a room, or open an existing
one. Links between the examples retain the room.
Each example stores its data separately inside that room's Yjs document.

- Draw shapes, freehand lines, text, and arrows with Excalidraw's native tools.
  Select, resize, group, and reorder objects, or pan and zoom around the scene.
- Teammates see cursors, selections, and live changes. Presence labels are
  client-supplied and do not establish identity or lock objects.
- Undo and redo affect this tab's changes. A pointer gesture creates one undo
  item. Shape changes synchronize during the gesture.
- Viewers can explore the scene and publish cursors, but cannot edit it.
- Fonts load from local assets included in development and production builds.
  Image insertion, embedded content, and scene-file import are disabled because
  this example has no attachment store. Local drawing export is available.

The [whiteboard model](examples/collaboration/whiteboard/model.ts) stores creation
records in `whiteboard:elements:v2` and property changes in `whiteboard:fields:v2`.
Position and size are separate atomic pairs, so moving an object does not overwrite
another participant's text or color edits. Concurrent changes to the same field
resolve through Yjs conflict rules. Text does not merge at the character level.
Deletion wins over a concurrent property edit.

Saved `whiteboard:objects:v1` scenes remain readable through a deterministic
adapter, including their sticky-note labels. Opening an old room does not write
migration updates. See the [Excalidraw integration notes](examples/collaboration/whiteboard/README.md)
for the scene model, asset setup, and package constraints.

Offline edits remain in the open tab until reconnecting. Wait for **Saved** before
closing it. The production build includes `/whiteboard.html` and uses the same
room permissions, PostgreSQL persistence, and recovery flow as the other examples.

`npm test` includes whiteboard concurrency and undo checks. Run its browser
checks separately from `mix test` with:

```sh
npm test --workspace synixir-collaboration-example -- whiteboard.spec.ts
```

## Try the rich-text example

Open [127.0.0.1:5173/rich-text.html](http://127.0.0.1:5173/rich-text.html) with the
same development servers running. Sign in and create a room, or open an existing
one. The plain-text editor remains available as its own example.

- Write paragraphs, three levels of headings, bullet and numbered lists, and quotes.
- Apply bold, italic, underline, and links to selected text. The link dialog accepts
  HTTP and HTTPS URLs and can update or remove an existing link.
- See collaborators' carets and selected text in their participant colors. Undo
  and redo affect edits made in this tab, leaving other participants' edits intact.
- Viewers can read and select text. Editing, formatting, and history commands are
  disabled for viewers and when access is revoked.
- Edits made while disconnected remain in the open tab and merge when it reconnects.
  Wait for **Saved** before closing the tab. Saved formatting and content recover
  after everyone leaves or the server restarts.

The [rich-text editor](examples/collaboration/rich-text/editor.ts) uses Tiptap with
its [Yjs collaboration extension](https://tiptap.dev/docs/editor/extensions/functionality/collaboration).
It binds to the `rich-text:content:v1` Y.XmlFragment in the SDK's document and uses
Synixir for synchronization and persistence. It does not require a separate
collaboration service. Tiptap's ordinary history is disabled in favor of Yjs undo.
A small awareness adapter uses `richTextCursor` so plain-text and rich-text cursor
positions never get mixed when both examples are open in the same room.

This is a text document example, with no images, file uploads, comments, or version
history. Each example has separate content within the room, while access and
storage quotas apply to the whole room.

Run its browser checks separately from `mix test` with:

```sh
npm test --workspace synixir-collaboration-example -- rich-text.spec.ts
```

## Try the multiplayer form example

Open [127.0.0.1:5173/multiplayer-form.html](http://127.0.0.1:5173/multiplayer-form.html)
with the same development servers running. Create a room or open an existing one,
then open the form in another tab to collaborate on a project brief.

- Edit the project name, goal, and audience together. Text changes merge at the
  character level, including changes made to the same field while disconnected.
- Choose a team, priority, target date, and launch channels. Separate fields and
  separate checkboxes merge independently. Concurrent changes to the same choice
  resolve to one value through Y.Map's conflict rules.
- See who is editing or viewing each field, with participant-colored outlines
  and shared text carets. These indicators do not lock fields. Presence clears
  when focus leaves the form, the window loses focus, or the peer disconnects.
- Track completion of the four required fields. Validation shows missing values
  and text length limits without discarding the shared draft.
- **Review brief** opens a live preview once required fields are complete. The
  preview updates when teammates edit. This example does not submit the form to
  an external service or record a finalized submission.
- Undo and redo affect this tab's edits across text and choice fields. Viewers
  can read, select text, and review the draft; they cannot edit or undo it.

The [form model](examples/collaboration/multiplayer-form/model.ts) stores text in
separate top-level Y.Text fields named `multiplayer-form:<field>:v1`, with choices
in `multiplayer-form:properties:v1`. The text controls reuse the existing
CodeMirror/Yjs binding for shared selections, composition input, and undo.
React Hook Form tracks local touched fields and review state, with Zod validation
through `@hookform/resolvers`. Incomplete shared drafts remain in Yjs while users
edit. See the [form integration notes](examples/collaboration/multiplayer-form/README.md).
The `multiplayerForm` awareness field identifies the active form field. All data
is separate from the other examples, with the same room permissions and storage.

Offline changes remain in the open tab until reconnecting. Wait for **Saved**
before closing it. Saved fields recover after all tabs close or the server restarts.

`npm test` includes form merge and validation checks. Run the browser checks
separately from `mix test` with:

```sh
npm test --workspace synixir-collaboration-example -- multiplayer-form.spec.ts
```

## Try the flowchart builder

Open [127.0.0.1:5173/flowchart.html](http://127.0.0.1:5173/flowchart.html) with the
same development servers running. Create a room or use an existing one, then open
another tab to build a workflow together.

- Add process, decision, and start/end nodes. React Flow provides dragging,
  resize handles, pan/zoom controls, and a minimap. Arrow keys move selected
  nodes; the inspector edits labels, colors, and sizes.
- Select a source node and choose a destination in **Connect to**, or use
  **Pick on canvas** and click another node. You can also drag between node
  connection handles. Label branches such as Yes and No.
- Select an arrow or its entry in **Connections** to edit its label or delete it.
  Deleting a node removes its attached arrows. One undo restores both.
- Live cursors, collaborator selections, and drag previews show where teammates
  are working. Arrows follow the displayed node positions during dragging.
- Undo and redo affect this tab's changes. Viewers can explore and select nodes
  and connections, while edits and history controls require editing permission.

The [flowchart model](examples/collaboration/flowchart/model.ts) stores nested
Y.Maps under `flowchart:nodes:v1` and `flowchart:edges:v1`. Fields merge independently;
concurrent edits to the same field resolve to one value using Y.Map's conflict
rules. Connections use a key derived from their source and target so concurrent
creation of the same arrow converges to one connection. Self-connections are
excluded; reverse connections and multiple outgoing branches are supported.
Arrows with deleted endpoints stay hidden, including ones created offline during
a deletion. Undo can restore their endpoints.

The `flowchart` awareness field carries temporary cursor, selection, and drag
positions. The React Flow adapter interpolates remote drag previews and commits
one position change per completed drag. Other examples keep separate data and cursor
fields within the same room. This is a diagram editor; it does not execute workflows
or automatically route arrows around intervening nodes.

Offline changes remain in the open tab until reconnecting. Wait for **Saved**
before closing it. Saved nodes and arrows recover after a server restart.

`npm test` includes connection merge, deletion, and undo checks. Run the browser
checks separately from `mix test` with:

```sh
npm test --workspace synixir-collaboration-example -- flowchart.spec.ts
```

## Try the collaborative table

Open [127.0.0.1:5173/table.html](http://127.0.0.1:5173/table.html) with the same
development servers running. Create a room or use an existing one, then open
another tab to work on the same table.

- New tables show three empty rows and Task, Owner, Status, and Due date columns.
  These are all text cells, so you can rename columns for a different use case.
- Click a cell to select it. Press Enter, double-click, or choose **Edit cell** to
  edit. Typing on a selected cell replaces its contents. Arrow keys move between
  selected cells; within an editor they move the caret. Tab moves to the next
  cell, Enter moves down, and Escape returns to cell selection.
- Collaborator-colored outlines show active cells with editing/viewing labels.
  When two people edit the same cell, they also see each other's text carets and
  selections. Text edits merge at the character level, including offline edits.
- Add rows and columns, rename a selected column, clear cells, or delete rows
  and columns. Undo restores deleted content and affects this tab's changes.
- Paste plain tab-separated text into a selected cell to fill a rectangle. The
  table adds rows and columns as needed, and one undo reverses the entire paste.
  Multi-cell paste also works while editing a cell. Paste uses literal text;
  quoted CSV parsing and spreadsheet formulas are not included.
- Viewers can select and copy cells, but cannot change data, paste, or use undo.
  On mobile, the table scrolls horizontally while the row numbers stay visible.

The [table model](examples/collaboration/table/model.ts) uses separate Y.Maps for
row order, column order, column names, and deletion markers. Default row and column
IDs are stable and require no initialization writes. Each cell uses a top-level
Y.Text named `collaborative-table:cell:[row-id,column-id]:v1`, with the IDs encoded
as a JSON array. Two users can edit an untouched cell without competing to create
its shared text. Concurrent rows and columns sort by order, then by stable ID.
Column names use Y.Map conflict resolution, while deletion markers hide rows and
columns independently of concurrent renames or text edits.

Deleted cells remain in the document so undo can restore them. The UI allows
adding up to 100 rows and 12 columns, and pasting at most 50,000 characters at a
time. These are example interaction limits, not server-enforced quotas;
concurrent additions can exceed them. `react-data-grid` provides navigation,
resizable columns, and virtualization. Column widths are local to each tab.
The active cell and cells with remote editors mount CodeMirror bindings so peers'
carets remain visible. Other visible cells render plain text. See the
[table integration notes](examples/collaboration/table/README.md).
The `collaborativeTable` awareness field carries the selected row and column;
text caret positions use the existing CodeMirror/Yjs awareness binding.

Data is separate from the other examples in the same room. Offline edits remain
in the open tab until reconnecting. Wait for **Saved** before closing it. Saved
cells and table structure recover after a server restart.

`npm test` includes table concurrency, deletion, and paste/undo checks. Run the
browser checks separately from `mix test` with:

```sh
npm test --workspace synixir-collaboration-example -- table.spec.ts
```

## Editor presence and connection states

Each account has a stable username; each editor visit gets a cursor color. The participant list
counts connected editor visits, including multiple tabs for one account. Names
and cursor positions are
temporary, client-supplied awareness data; they do not establish identity or room
permissions. Awareness is scoped to the room, removed when the channel leaves,
and announced again after reconnecting. Focusing another control clears the
local cursor. Nothing in awareness is written to the document update log.

**Connecting** means the initial sync is in progress. **Connected** means the
channel has joined and synced. **Reconnecting** appears after a connection is
lost. Each automatic reconnect fetches a fresh grant and creates a fresh channel.
**Disconnected** means you clicked Disconnect. Owners and editors can
keep editing offline, and the save status reports any unconfirmed changes.
Rejected joins show **Access expired or denied** or **Room unavailable** and stop
retrying that join. **Connect** requests a fresh authorized room token and retries without
discarding local edits. Access requests and channel joins time out after 10 seconds.
If the role changed while disconnected, reload with the new permissions after
copying any unsaved draft. Reconnect also checks the current account before
reusing a document and waits for the previous socket to finish closing.

## Accounts and room permissions

Accounts use stable UUIDs and unique, case-insensitive public usernames. Usernames
contain 3–32 ASCII letters, digits, underscores or hyphens and start with a letter
or digit. They are handles, not verified email addresses. Passwords use Argon2id
with the package's production defaults; only tests reduce the hashing cost.
Self-service password recovery, email verification, MFA, and external identity
providers are outside this implementation.

The browser stores an opaque random session token inside Phoenix's signed,
HttpOnly, host-only session cookie. PostgreSQL stores its SHA-256 digest and a
seven-day expiration. The cookie uses `SameSite=Lax` and `Secure` in production,
which requires HTTPS. Login renews the cookie and rotates CSRF state; logout
deletes the session before returning success. Every authenticated HTTP request
looks up the session, and room operations check it again at their authorization
boundary. Authentication attempts are limited to 20 per remote IP per minute in
one node, before password hashing. This limiter uses the connection's remote IP.
The local Docker gateway overwrites forwarded client addresses; production trusts
those headers, so keep the app listener private to the gateway. Room and channel
quotas are described in the [operations guide](docs/operations.md).

All JSON API routes fetch the session and use CSRF protection. First fetch
`GET /api/session`, retain its `csrf_token` in memory, and send it as
`x-csrf-token` for state-changing requests. Retain the returned cookies. Responses
use `Cache-Control: no-store`. The Next.js development server proxies `/api` and `/socket` to Phoenix.
The Docker release serves the frontend, API, and WebSockets through one HTTPS
origin. Production WebSocket origin checks include the scheme and port. Socket
connections alone carry no identity: each room join must present an authorized
bearer grant.

| Method and path | Purpose |
|---|---|
| `GET /api/session` | Current account or `null`, plus CSRF token |
| `POST /api/accounts` | Register with `username` and `password`, then sign in |
| `POST /api/session` | Sign in with `username` and `password` |
| `DELETE /api/session` | Revoke the current session and sign out |
| `GET /api/rooms` | List the account's active memberships |
| `POST /api/rooms` | Create `room_id` and its initial owner atomically |
| `POST /api/rooms/:room_id/token` | Issue a grant using current session and membership |
| `GET /api/rooms/:room_id/members` | Owner-only membership list |
| `PUT /api/rooms/:room_id/members/:username` | Owner grants or changes `role` |
| `DELETE /api/rooms/:room_id/members/:username` | Owner revokes membership |

Room endpoints return `{data: ...}` on success and `{error: ...}` on failure.
Token responses contain `token`, `user_id`, `role`, and the session's `expires_at`.
Client-supplied user IDs or roles cannot change the authenticated account.
Membership management accepts only `owner`, `editor`, and `viewer`.

| Permission | Owner | Editor | Viewer |
|---|---|---|---|
| Join and receive document/presence | Yes | Yes | Yes |
| Publish valid ephemeral awareness | Yes | Yes | Yes |
| Save document changes | Yes | Yes | No |
| List and manage members | Yes | No | No |

Each room has one membership per account, and at least one owner. Administration
locks the room row so concurrent role changes cannot remove the final owner.
Multiple owners are allowed. A membership version increments on every role
change or revocation; re-adding an account never makes an old grant valid again.

`Synixir.RoomAccess.issue(room_id, session_hash)` is a trusted server API. HTTP
clients obtain grants through the authenticated token endpoint. Signed grants
bind the room, account, session, and membership version. They expire for new
joins after 15 minutes; existing channels remain subject to the underlying
session expiration and current membership. Tokens from the old development
issuer are invalid. The `/api/demo/room-token` route has been removed.

Inside the document worker, an authorized update locks its session and room,
checks current membership, applies Yex, and commits the raw update bytes in one
transaction before replying **Saved**. Logout conflicts on the session lock;
role changes conflict on the room lock. A write authorized first can finish
before revocation commits. After revocation commits, queued or newly completed
chunk uploads cannot write using stale access. Storage or commit failure stops
the mutated worker before queued broadcasts run. Save telemetry also waits for
that commit.

Channels subscribe to session and membership notifications before observing a
room and recheck access after observation. Durable revocation closes affected
channels and discards incomplete transfers. Permission checks also run before
accepting messages and before forwarding queued document or awareness data, so
correctness does not depend on receiving a PubSub notification. Idle channels
check session expiry every 30 seconds; messages always recheck current access.
Data already sent over the network cannot be recalled.

Viewers receive the server's sync response without a reverse upload request.
Their client disables editing, undo/redo, and save tracking. The server rejects
all update encodings with `read_only`, including raw saves, protocol updates,
and reassembled transfers. UI controls are not an authorization boundary.

### Existing documents and trusted server access

`Synixir.Documents.open/1` still finds or starts the single supervised Yex process
for a room, using UTF-16 offsets. Its direct `sync/2`, `save_update/2`, storage,
and compaction functions are trusted server APIs. Browser channels use the
separate authenticated path. Ownership remains local to one Phoenix node.

Migrate the database before running the updated server, then restart it. Existing
document logs and snapshots remain intact. They have no implicit owner: public
room creation refuses IDs that already contain legacy data, preventing an account
from claiming someone else's document. After the intended owner registers, an
operator can adopt a specific document from trusted server code:

```elixir
user = Synixir.Repo.get_by!(Synixir.Accounts.User, username: "alice")
{:ok, _room} = Synixir.RoomAccess.adopt_legacy_room("design-notes", user)
```

No documents are adopted automatically. The chosen owner can then grant other
members access through the example or API. See the
[authentication research](docs/research/authentication-permissions.md) for the
library guidance and transaction design.

## Persistence and save acknowledgements

The `document_updates` table stores incoming Yjs v1 update bytes, indexed by
room and insertion order. A SHA-256 digest makes repeated delivery of identical
bytes within a room a no-op while those bytes remain in the log. After compaction,
retrying an older update is still safe because Yjs updates are idempotent. Room
startup loads the latest snapshot and replays its remaining log before accepting
joins, and normal Yjs state-vector sync supplies missing changes to
reconnecting clients.

The room process validates and applies an update, commits its incoming bytes,
then acknowledges the request and broadcasts the change. It stores incoming
bytes even when Yex is waiting for a missing dependency. Saving only emitted
document changes would lose those pending updates on a crash. A failed database
write stops the modified in-memory process without a saved acknowledgement or
broadcast. A load failure refuses the join instead of serving an empty document.

Before an update reaches the room process, `Synixir.Documents.Protocol` checks
its size and validates it using a disposable Yex document in the caller. Invalid
updates, state vectors, and awareness messages are rejected without modifying
the shared document or disconnecting its other collaborators. Applying an update
to the live document still happens before its bytes are committed.

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

The SDK sends incremental updates through this save path and a full update
when it reconnects. Its chunk transport adapter splits large uploads, handshake
responses, and server broadcasts into bounded messages. Only the final chunk
can confirm a durable save. Duplicate delivery through the standard provider is
safe.
Its save tracker waits for acknowledgements covering every local edit, including
deletions, and ignores late replies from old connections. **Connected** reports
sync progress. **Saved** confirms database persistence; **Saving**, **Unsaved
changes**, and **Save failed** do not. A timeout may mean the write committed
but its reply was lost. Reconnect to retry and obtain confirmation.

## Limits and failures

The defaults in `config/config.exs` are:

| Limit | Default |
|---|---|
| Binary channel payload | 1 MiB, including the Yjs protocol envelope when present |
| Awareness update inside a protocol message | 16 KiB |
| Chunk data | 256 KiB, plus a 13-byte header |
| Reassembled transfer | 64 MiB |
| Partial transfer lifetime | 30 seconds from its first chunk |
| Message rate per joined channel | 120 messages/second, with a burst of 240 |
| WebSocket frame or assembled fragmented message | 2 MiB |

The message budget includes updates, awareness, sync requests, and unsupported
events. It refills over time; excess requests receive `rate_limited` without
entering the document process. Another collaborator has a separate budget.
Rejoining starts a new budget. Separate admission quotas bound joined channels
per account, room and node, along with resident documents and rooms owned by an
account. The local Docker gateway also limits active connections and HTTP request
rates per IP. These are staging defaults to tune for the deployed workload; see
the [gateway configuration](docs/deployment.md#release-contents-and-ingress).

Payload sizes and rate settings use the `:collaboration_limits` application
configuration. The transport limits are configured separately in the endpoint
and Bandit HTTP options. Restart Phoenix after changing them. Keep payload
limits below the transport ceiling, allowing space for Phoenix's envelope.

Awareness states must be JSON objects. Optional `user` and `cursor` fields must
match the example's format: names and shared type names are at most 128 UTF-8
bytes, colors use six- or eight-digit hex notation, and cursor positions contain
valid Yjs IDs and integer offsets. Other awareness fields remain available for
application metadata. Awareness data still does not establish user identity.

Channel failures return `{reason: "message_too_large"}`, `rate_limited`,
`invalid_message`, `invalid_chunk`, `read_only`, `unauthorized`,
`unsupported_message`, `storage_unavailable`, or
`document_unavailable`. The example explains oversized edits, rejected updates,
rate limits, and missing acknowledgements next to its save indicator. It keeps
unconfirmed text in the tab. A transport limit closes the socket before channel
processing, so it cannot return a channel error reply.

The 1 MiB cap applies to individual messages, not accumulated document history.
The example supports larger documents through chunked transfers. The separate
64 MiB transfer cap bounds reassembly memory and is the practical ceiling for
encoded reconnect state in this version. Deleting visible text does not remove
all CRDT history, and log compaction does not guarantee a smaller encoded state.
An edit or reconnect state beyond the transfer cap needs a smaller document or
an explicitly configured higher cap with sufficient server and browser memory.

### Chunked sync protocol

A client opts in with `chunked_sync: 1` in its authorized join parameters. The
join reply includes `transfer` with `max_message_bytes`, `chunk_bytes`,
`max_transfer_bytes`, and `transfer_timeout_ms`. The SDK's internal
[chunked-transport.ts](packages/client/src/chunked-transport.ts) wraps the
existing Phoenix channel provider. Clients without this option keep the original
protocol and per-message size limit.

Large client messages use the binary `transfer_chunk` event. Each payload has a
13-byte header followed by data. Header fields are an unsigned one-byte event
kind (`0` for `yjs`, `1` for `yjs_sync`, `2` for `save_update`), then unsigned
32-bit big-endian transfer ID, byte offset, and total reassembled byte length.
Offsets must be contiguous. A chunk at offset zero starts or replaces the
channel's one partial upload. Later chunks must match its kind, ID and total.
Each fragment consumes the existing per-channel message budget. The example
sends fragments sequentially with acknowledgements and pacing.

Intermediate replies are `{saved: false}` and do not change the shared document
or database. After the last chunk, the server validates the complete original
message in a disposable document, then applies and commits its raw update bytes
through the same save path as an ordinary message. Only that successful commit
returns `{saved: true}`. An incomplete transfer expires after 30 seconds and is
also discarded when the channel exits. Reconnecting retries from the beginning.
Malformed or discontinuous fragments return `invalid_chunk`; expired transfers
must start again at offset zero. Payload and awareness validation remain active.

Large server messages arrive as `yjs_chunk` with the same header and kind `0`.
The adapter reassembles a whole message before delivering it to the Yjs provider.
It bounds incoming memory and outgoing queued bytes, resets on connection
changes, and preserves the save tracker's stale-reply protection. A protocol
response beyond the negotiated cap fails sync; it cannot mark a partial document
as connected. The 2 MiB WebSocket limits still apply to every transport message.

## Document lifetime

Documents are created on demand and unload after 60 seconds without an observer.
A new join cancels the idle timer; the final observer leaving or crashing starts
a new grace period. Rooms opened by server code without an observer also expire
after inactivity. Idle workers stop normally and leave the Registry; the next
join starts a worker and restores its committed snapshot and remaining updates.
After a document crash or server restart, recovery uses the same path. Channels
attached to a failed process close so clients can rejoin. Document processes use temporary supervision to avoid an
automatic restart loop during a database outage; other rooms keep running.

Use a new room ID for a fresh document. Restarting Phoenix no longer resets
saved content. Offline changes remain only in that tab until acknowledged as
saved; closing or reloading an offline tab loses unsent edits. Existing content
from the earlier memory-only implementation is not imported automatically.

### Snapshots and compaction

Incoming updates first enter the append-only `document_updates` log. The room
queues compaction after 256 save submissions or 4 MiB of submitted update bytes
since its last successful compaction. Compaction runs serially in the room
worker; large merges can delay that room's requests. On restoration, the remaining log counts
toward those thresholds. Settings live in `:document_lifecycle` as
`compact_after_updates`, `compact_after_bytes`, and `idle_timeout_ms`.
Trusted server code can also request `Synixir.Documents.compact(document_pid)`.

Compaction merges the previous snapshot with the raw committed update bytes via
`Yex.merge_updates/1`. The `document_snapshots` row stores that replay update,
its SHA-256 checksum, and the last covered update ID. Snapshot replacement and
deletion of covered log rows happen in one PostgreSQL transaction. Append,
restore, and compaction take the same per-room transaction lock, so restoration
cannot observe a snapshot and tail from different compaction states. A process
crash rolls back an unfinished transaction; a failed compaction retains the
previous snapshot and log and is retried after another save. Saved edits do not
depend on compaction or graceful shutdown.

Yex 0.10.5's `encode_state_as_update/1` omits pending inserts and delete sets
waiting for missing dependencies. Storage snapshots use raw update merging to
retain those dependencies and deletions,
even across repeated compaction. A checksum mismatch, invalid replay data, or
storage read error refuses restoration. Awareness remains ephemeral. The
[research and probe results](docs/research/storage-lifecycle.md) explain the pinned
library behavior.

These snapshots consolidate CRDT updates and duplicate history; they do not
provide user-visible versions, retention, or garbage collection of all deleted
history. Multi-node room ownership is not implemented.

Yex uses precompiled native binaries on supported platforms. The Docker release
pilot exercises both Yex and Argon2 inside the final image. It has passed locally
on ARM64 and emulated AMD64, and CI runs it on native AMD64.

## Telemetry

These events use `:telemetry.execute/3`; `SynixirWeb.Telemetry.metrics/0` defines
the corresponding counters, summaries, and active-document gauge:

| Event | Measurements | Metadata |
|---|---|---|
| `[:synixir, :channel, :join]` | `duration`, `count` | `result` |
| `[:synixir, :channel, :message]` | `duration`, `count`, `bytes` | `event`, `result` |
| `[:synixir, :document, :save]` | `duration`, `count`, `bytes`, `inserted` | `result` |
| `[:synixir, :document, :restore]` | `duration`, `count`, `bytes`, `updates` | `result` |
| `[:synixir, :document, :compact]` | `duration`, `count`, `bytes`, `updates` | `result` |
| `[:synixir, :document, :unload]` | `count` | none |
| `[:synixir, :documents]` | `active` | none |

Durations use native time units. The metric definitions convert them to
milliseconds. Message duration includes validation, document queueing, and the
operation itself. Save duration covers the database write; `inserted: 0` with
`result: :ok` identifies duplicate bytes already in the log. Restore counts and
bytes describe the replayed log. Failed restores report zero counts. Compaction reports removed log rows and the
resulting snapshot size. Idle unloads increment a counter. Active
documents are sampled every 10 seconds and include rooms with no participants.

These events contain no document content, tokens, room IDs, or user IDs. Labels
use a fixed set of event names and outcomes. The Prometheus exporter uses a
separate metric list in `Synixir.Operations.Metrics`, converts durations to seconds,
and normalizes labels through finite allowlists. Enable `/metrics` with
`SYNIXIR_METRICS_TOKEN`; health checks, alert rules and backup commands are in the
[operations guide](docs/operations.md). No dashboard or alert receiver is installed.
To inspect save outcomes locally in `iex -S mix phx.server`:

```elixir
:telemetry.attach(
  "inspect-document-saves",
  [:synixir, :document, :save],
  fn event, measurements, metadata, _config ->
    IO.inspect({event, measurements, metadata})
  end,
  nil
)

# Remove the handler when finished:
:telemetry.detach("inspect-document-saves")
```

## Checks

```sh
MIX_ENV=test mix deps.get --check-locked
MIX_ENV=test mix compile --warnings-as-errors
mix format --check-formatted
mix test
```

`mix test` creates and migrates `synixir_test` before checking room ownership,
authorization, save acknowledgements, recovery of pending updates, and database
failure behavior. It also checks malformed and oversized payloads, message
budgets, and telemetry outcomes. Authentication checks cover CSRF, session expiry,
role boundaries, legacy document ownership, queued writes and broadcasts after
revocation, and logout concurrent with a real committing write. Lifecycle checks cover repeated compaction with
pending dependencies and deletions, corrupt snapshots, idle observer races,
chunk validation and expiry, and killing a compactor after its uncommitted
snapshot write. The crash test uses real commits in a unique room and cleans up
only that room's data. PostgreSQL is required. Test partitions append
`MIX_TEST_PARTITION` to the test database name.

Install JavaScript dependencies from the root workspace lockfile, then check the
SDK and browser examples:

```sh
npm ci
npm test
npm run test:package
npm run build
cd examples/collaboration
npx playwright install --only-shell chromium
npm test
```

The SDK unit tests cover lifecycle cancellation, stale access callbacks, account
boundaries, and subscriptions through its public entry point. The package check
installs a real npm tarball into an isolated consumer and verifies ESM imports,
shared Yjs identity, TypeScript NodeNext/bundler declarations, and a Vite build.
It does not publish the package. Run browser tests separately from `mix test`;
both use `synixir_test`.

Playwright migrates the test database and starts its own Phoenix server on port
4010 and Next.js on port 5174, then shuts them down. Those ports must be free;
your development servers can keep running on ports 4000 and 5173. Each test uses
unique room IDs so saved data from previous runs does not affect the assertions.
The fixture sets `SYNIXIR_BROWSER_TEST=true` for its subprocesses, selecting a
regular four-connection database pool. ExUnit keeps SQL Sandbox. Browser tests
check that open rooms release database connections between operations so new
accounts can still register. Failed tests also print the recent Phoenix server
log to make HTTP and channel failures diagnosable in CI.

Browser tests fail on unhandled page exceptions. SDK-specific browser checks
cover synchronization before save acknowledgement, a shared Y.Map consumer,
fresh-grant recovery, overlapping disconnect/connect, destruction, and suppression
of programmatic viewer writes. The browser tests also check room isolation, typing and selection replacement,
multiline and Unicode edits, local undo/redo, remote selections following edits,
participant departure and reconnect, and cancelling navigation with unsaved
changes. They also check concurrent offline edits. The
durability test waits for **Saved**, closes all original clients, kills its
Phoenix process with `SIGKILL`, and recovers the text in a fresh browser context.
It also covers a Unicode deletion and offline edits across another restart.
This runs against real PostgreSQL commits, outside the ExUnit SQL sandbox.
Failure tests hold actual WebSocket save replies to verify acknowledgement
ordering and timeout handling, reject grants on initial join and rejoin, and
check that an oversized edit is neither shown as saved nor recovered by a new
client. The backend still performs the real writes during reply-loss tests.
Browser permission tests cover signup, owner management, read-only viewers, role
changes while connected or offline, and clearing document state across logout and
account changes, including cookie changes without a storage notification. The
collaboration regression tests now provision real accounts and memberships through
the public API. Lifecycle browser tests exercise documents above 1 MiB, chunked broadcasts,
offline concurrent edits and deletions, snapshot recovery after `SIGKILL`,
interrupted uploads, and missing final chunk acknowledgements. Transport tests send oversized frames and fragmented messages over a real
WebSocket connection and check that both close with code 1009. They also verify
that the WebSocket handshake rejects an untrusted browser origin.

The [CI workflow](.github/workflows/ci.yml) runs these checks on pull requests
and pushes to `main`. It uses the versions in `.tool-versions` and the same
PostgreSQL image as Compose. Each run gets a fresh database and runs the browser
test in Chromium. CI checks formatting without modifying files, installs
JavaScript dependencies from the lockfile, and fails if Elixir dependency
resolution would change `mix.lock`. It also verifies backup restoration,
concurrent quotas, SDK load and replay, and Prometheus configuration and alerts.
A separate job builds the production Docker image on native AMD64 and runs the
HTTPS staging pilot in a disposable Compose project.

Production runtime configuration is in `config/runtime.exs`. It reads
`DATABASE_URL`, `SECRET_KEY_BASE` and an HTTPS `SYNIXIR_PUBLIC_URL`, with optional
`PORT` and `POOL_SIZE` settings. The [local Docker staging runbook](docs/deployment.md)
builds a production release with the browser assets, a private PostgreSQL database,
an HTTPS gateway and Prometheus. It includes a packaged browser pilot, verified
backups and single-node replacement. A separate CI job runs that pilot against
the final AMD64 image. Public hosting remains a separate deployment decision.

Generated with the [Phoenix 1.8.13 generator](https://phoenix.hexdocs.pm/1.8.13/Mix.Tasks.Phx.New.html),
using PostgreSQL and disabling HTML, assets, LiveDashboard, Gettext, and mailer
generation.
