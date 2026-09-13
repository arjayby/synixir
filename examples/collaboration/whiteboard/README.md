# Excalidraw whiteboard

The whiteboard loads `@excalidraw/excalidraw` only when its route opens. Excalidraw
owns drawing, text editing, selection, resizing, grouping, connectors, pan, and
zoom. `@synixir/client` still owns the room connection, access checks, offline
updates, saved acknowledgements, and PostgreSQL persistence through Phoenix.
No Excalidraw collaboration service is used.

## Shared scene

`model.ts` stores immutable creation records in `whiteboard:elements:v2` and
field changes in `whiteboard:fields:v2`. Each changed field has its own Yjs key.
Position and size are each atomic pairs. Different fields and different objects
merge independently. Two concurrent edits to the same field use Yjs conflict
resolution. Text edits replace an element's text value; this is not a Y.Text
character-level binding.

Deletion sets an `isDeleted` tombstone, so a stale canvas cannot bring an object
back by moving it. Reverse arrow and text bindings are derived from the linked
elements, preserving concurrent arrows that target the same shape. Fractional
indices determine drawing order using raw lexical comparison. Rendering uses a
deterministic version nonce for the merged fields to invalidate Excalidraw's
shape cache without adding a competing revision counter.

The adapter compares each local scene callback with its last rendered scene,
writes only changed fields, and applies remote scenes with
`CaptureUpdateAction.NEVER`. The workspace Undo/Redo controls and keyboard
shortcuts use a Yjs UndoManager that tracks this adapter's local origin. Remote
updates are excluded. A pointer gesture is one undo item.

`whiteboard:objects:v1` remains readable. Old sticky notes, rectangles, ellipses,
colors, dimensions, positions, and labels are projected into Excalidraw elements
with deterministic IDs. V2 field edits overlay those records. Opening a legacy
room, including as a viewer, does not write migration updates or add undo items.

## Presence and permissions

Pointers and selected element IDs use the `whiteboard` awareness field and
Excalidraw's collaborator renderer. The first movement after idle publishes
immediately; subsequent movements coalesce at 60 ms intervals. Remote cursors
interpolate over 60 ms through `lib/cursor-motion.ts`, shared with the flowchart.
Reduced-motion and hidden tabs use the received position directly. Cursor-only
callbacks skip scene diffing and Yjs transactions when element revisions have
not changed. Presence never enters the scene document.
The adapter clears the pointer on exit/blur, removes disconnected peers, and
cleans up subscriptions when leaving the room. Excalidraw view mode follows the
SDK's read-only flag, including live access revocation. The first received scene
is fitted into the viewport; later remote edits preserve the user's viewport.

## Assets and package constraints

Image insertion, image paste/drop, loading scene files, and embedded content are
disabled. This example has no binary attachment store. Drawings, text, arrows,
and groups are shared. Scene and image export remain available locally.

`copy-assets.mjs` copies the installed package's font assets into
`public/excalidraw-assets` during `predev` and `prebuild`. These generated assets
are ignored by Git and included in the static Next.js export. Font loading tries
this local path first, so normal rendering does not depend on a CDN.

The `0.18.1` package currently pulls `nanoid` `3.3.3` and `4.0.2`, and
`lodash-es` `4.17.21`. npm audit reports advisories in those transitive
dependencies. Parent-scoped and version-qualified npm overrides did not change
the resolved workspace dependencies, including after a clean install; no
ineffective override is retained. npm tracks this workspace resolution behavior
in [npm/cli#9659](https://github.com/npm/cli/issues/9659).

## Verification

`model.test.ts` checks field convergence, local undo/redo, deletion against stale
edits, concurrent bindings, migration, rank ordering, and malformed shared data.
The whiteboard browser suites exercise native drawing and text tools, live drag
and awareness, keyboard movement, resizing, offline merges, restart recovery,
mobile layout, and access changes through real authenticated rooms.
