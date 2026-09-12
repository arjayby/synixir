# Collaborative kanban

The board renders React cards with `@dnd-kit/react` 0.5.0. Each card has a dedicated drag handle that supports mouse, touch, and keyboard input. Focus the handle, press Space, move with the arrow keys, and press Space again to drop. Escape cancels. The card's Status control remains available without dragging.

`board-view.tsx` owns sortable previews and the existing shadcn buttons and badges. `board.ts` connects completed drops to the Synixir room and retains the card-details dialog, active-card presence, caret handling, permission updates, and local undo. The workspace still loads `createBoard(room)` and disposes it through the same cleanup function.

The shared document keeps one `Y.Map` per card in `kanban:cards:v1`. Column and rank form one atomic placement value, so simultaneous moves resolve to one placement. Cards added by the earlier example still load from their numeric `order`; there is no document-wide migration. New placements add a lexicographic numeric path in `rank`. A stable card ID breaks ties between concurrent equal ranks. Inserting between cards extends that path when floating-point precision is exhausted, without rewriting neighboring cards or their concurrent changes.

During a drag, dnd-kit owns the visual preview. Remote updates continue to merge into the Yjs document. Dropping translates the preview into a destination column and the next card's ID, then applies one local action against the latest document. Canceling discards the preview and renders the current document. Permission revocation cancels an active drag before any placement is written. Presence and previews never enter undo history.

Run the model tests with `node --import tsx --test examples/collaboration/kanban/model.test.ts`. The kanban browser suite covers pointer, touch, and keyboard moves, cancellation, peer edits during a drag, local undo, offline reconnection, persistence after a server crash, viewer access, and mobile layout. See the [dnd-kit sortable state guide](https://dndkit.com/react/guides/sortable-state-management/) for the preview and drop APIs.
