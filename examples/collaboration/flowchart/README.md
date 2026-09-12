# Collaborative flowchart

The canvas uses [`@xyflow/react` 12.11.6](https://reactflow.dev/) with custom
process, decision, and terminal nodes. React Flow supplies dragging, connection
handles, selection, resizing, pan/zoom controls, and a minimap. The inspector uses
the app's shadcn components and also provides keyboard-accessible connection and
size controls. The package and this integration require no React Flow Pro code.

Add nodes with the toolbar. Drag an outgoing handle to another node's incoming
handle, or choose a destination in the inspector. Select an arrow to edit its
label or delete it. Select a node and drag a resize handle, or enter Width and
Height and press Enter. Arrow keys move a selected node one pixel; Shift moves it
ten. Delete removes the selection. The workspace's Undo/Redo buttons and
Control/Command+Z apply to local graph edits. Drag the background to pan, scroll
to zoom, or use the controls to fit the diagram.

`model.ts` retains the existing `flowchart:nodes:v1` and `flowchart:edges:v1` Yjs
maps, so saved diagrams load without migration. Node properties are separate map
entries, and each edge has a deterministic source/target key. Concurrent edits to
independent properties merge without replacing the graph. Deleting a node and
its connections remains one undoable action.

`adapter.ts` converts that model into controlled React Flow nodes and edges.
Measurements and selection stay local. Drag and resize previews do not write to
Yjs; releasing the pointer commits one action. Resizing from the top or left
commits position and dimensions together. A bottom-right resize preserves an
independent remote move. Read-only updates cancel pending gestures and guard all
mutation paths.

`presence.ts` sends cursor, selected node, and drag previews through Synixir
awareness at most once per 60 ms. Remote drag positions interpolate over 80 ms,
respecting reduced motion. Arrows read the same React Flow node positions as the
canvas so they stay attached during interpolation. Remote cursors interpolate
through the shared `lib/cursor-motion.ts` helper over 60 ms, without rebuilding
the graph or writing to Yjs. Reduced-motion and hidden tabs use the received
position directly. Viewports remain local.
Synixir continues to own room access, offline edits, reconnect, and persistence.

The implementation follows the public [custom-node API](https://reactflow.dev/learn/customization/custom-nodes),
[controlled-flow API](https://reactflow.dev/api-reference/react-flow), and
[NodeResizer API](https://reactflow.dev/api-reference/components/node-resizer).
`model.test.ts` covers adapter persistence boundaries, concurrency, undo, and
permission changes. `tests/flowchart.spec.ts` covers two-browser synchronization,
handle connections, resizing, pointer motion, offline/restart behavior, and
mobile viewer permissions.
