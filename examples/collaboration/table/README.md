# Collaborative table

The table uses [`react-data-grid`](https://github.com/Comcast/react-data-grid) for keyboard navigation, resizable columns, a frozen row-number column, and row/column virtualization. The example pins `7.0.0-beta.61`, the current npm release, which is a prerelease and requires React 19.2 or later.

Synixir still owns room access, transport, persistence, reconnection, and permissions. The existing Yjs model and document names are unchanged, so saved tables remain compatible.

## Editing and presence

Each cell has a stable row ID, column ID, and its own `Y.Text`. `cell.tsx` mounts a CodeMirror editor with `y-codemirror.next` into the grid's custom editor. Typing updates that text immediately; the grid does not commit a replacement row or string when editing ends. Remote text updates keep the active editor mounted, preserving character-level merging and local undo.

Cells with a remote editor also mount a passive, read-only CodeMirror binding. This displays remote selections and carets without requiring the local user to open that cell. Other cells render plain text. The grid keeps an active cell mounted when scrolling it outside the viewport and virtualizes the rest.

Row and column selection follows IDs when the schema changes. Removing a preceding row or column ends the current edit and keeps the same cell selected at its new address. Removing the selected cell clears selection. Deleted cells remain in Yjs so undo and disconnected edits can restore their contents.

`createCollaborativeTable(room)` retains the workspace's mount, cleanup, and `setReadOnly` contract. Permission changes reconfigure live editors immediately and guard mutation actions, paste, undo, and browser history input. Passive bindings never enter the local undo history or publish a local caret.

## Controls

- Enter, F2, double-click, or **Edit cell** opens a cell. Typing from a selected cell starts replacement text.
- Escape ends editing. Enter moves down; Shift+Enter moves up. Tab and Shift+Tab move between data cells and wrap across rows.
- Arrow keys, Home/End, and Page Up/Down use the grid's navigation. Drag a column header edge to resize it locally.
- Paste tab-separated text from a spreadsheet to fill a rectangle, adding rows and columns as needed. A paste is one undoable action. Plain text pasted inside an editor uses the live Y.Text binding.
- Add, rename, clear, delete, undo, and redo remain collaborative. The example permits 100 rows, 12 columns, and 50,000 pasted characters.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run build` from the repository root. Run `npm run test:browser -- table.spec.ts` for the browser checks. They cover concurrent typing, passive and active remote carets, undo, paste, schema changes, reconnection, backend restart, viewer permissions, live downgrades, resizing, virtualization, and mobile overflow. The populated-grid test writes desktop and mobile screenshots to `/tmp/synixir-table-desktop.png` and `/tmp/synixir-table-mobile.png`.
