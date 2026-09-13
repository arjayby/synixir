# Libraries for the collaboration examples

Researched on 2026-09-13 against official documentation and source repositories. Recommendations are judgments about these examples, with Synixir and Yjs retained for synchronization, permissions, and persistence. No packages were installed or application code changed.

## Kanban

For a React board, prefer `@dnd-kit/react` with its sortable hooks. The current documentation uses this package and `@dnd-kit/helpers`; it labels `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` as the legacy API. It supplies sorting across containers, pointer/touch/keyboard input, ARIA defaults, screen-reader instructions, and live regions under the MIT license. These are useful improvements over maintaining native drag handlers as the board grows. Sources: [current React quickstart](https://dndkit.com/react/quickstart/), [migration guide](https://dndkit.com/react/guides/migration/), [official source and features](https://github.com/clauderic/dnd-kit).

The present board is imperative DOM code, so adopting the React hooks means rewriting its rendering. `@dnd-kit/dom` offers a plain TypeScript alternative. Atlassian's `@atlaskit/pragmatic-drag-and-drop` is another sensible choice when retaining the current DOM structure and browser-native drag behavior. Its core works independently of a UI framework; accessible alternatives and announcements need explicit implementation. It is Apache-2.0 licensed. Sources: [dnd-kit architecture](https://github.com/clauderic/dnd-kit), [Pragmatic source](https://github.com/atlassian/pragmatic-drag-and-drop), [accessibility guidance](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines/), [license](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/LICENSE).

Integration judgment: keep card IDs, ordering, and column changes in the existing Yjs model; translate completed drags into model actions. Neither package supplies collaboration. dnd-kit's manual state management supports custom data structures, which fits this boundary better than treating its array-moving helper as the shared database. Source: [sortable state management](https://dndkit.com/react/guides/sortable-state-management/).

## Whiteboard

Prefer `@excalidraw/excalidraw` if the goal is a complete drawing UI with permissive licensing. Excalidraw is MIT licensed and provides a finished editor. Its embeddable package deliberately leaves collaboration to the host application, with `onChange`, `onPointerUpdate`, and `updateScene` available for integration. Sources: [official repository](https://github.com/excalidraw/excalidraw), [license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE), [collaboration FAQ](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/faq), [props](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props), [scene API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api).

Integration judgment: this saves drawing-interface work but requires a substantial Synixir/Yjs adapter. It must reconcile element changes and deletions, avoid echoing remote changes, coordinate undo, and map presence. Replacing the entire scene with one shared JSON value would lose the benefit of independent concurrent edits. Excalidraw's hosted app having collaboration does not mean installing the package enables it.

`tldraw` is a strong alternative for a customizable infinite canvas. It supports custom realtime backends through its store and presence APIs. However, production use requires an active trial, commercial, or discretionary non-commercial hobby license; downstream users of an open-source example also need their own production license. Its default sync implementation uses a separate JavaScript/WebSocket backend, so retaining Synixir requires a custom adapter. Sources: [custom backend support](https://tldraw.dev/docs/collaboration), [sync architecture](https://tldraw.dev/docs/sync), [licensing](https://tldraw.dev/community/license).

Use `konva` with `react-konva` only if keeping a deliberately small custom whiteboard is the priority. Konva provides canvas shapes, events, and dragging; the editor tools and collaboration remain our work. Konva is MIT licensed, and the React wrapper's major version must match React's major version. Sources: [React integration](https://konvajs.org/docs/react/index.html), [license](https://github.com/konvajs/konva/blob/master/LICENSE).

## Flowchart

Prefer `@xyflow/react`, React Flow. It is MIT licensed and supplies node dragging, connections, pan/zoom, selection, resizing, custom React nodes, and minimap/controls. This is the clearest replacement for the custom DOM/SVG canvas. Source: [React Flow](https://reactflow.dev/).

Keep the existing Yjs data model and map node/edge changes into it. React Flow documents Yjs-based collaboration and distinguishes durable graph fields from local selection and transient cursor state. Its downloadable collaborative example uses the separate xyflow Pro license; that does not make the library or an independently written Synixir integration paid. Sources: [multiplayer guide](https://reactflow.dev/learn/advanced-use/multiplayer), [collaborative example license](https://reactflow.dev/examples/interaction/collaborative).

Add layout only when requested. React Flow has no built-in automatic layout engine. Dagre fits simple directed layouts; `elkjs` supports more complex arrangements and edge routing but adds configuration work. ELK uses EPL-2.0 rather than MIT. Sources: [layout comparison](https://reactflow.dev/learn/layouting/layouting), [ELK license](https://github.com/kieler/elkjs/blob/master/LICENSE.md).

## Text editor

Keep CodeMirror 6 with `y-codemirror.next`. The binding already supplies Y.Text synchronization, remote selections, and undo/redo. Its maintainers explicitly recommend the stable `y-codemirror.next` package with Yjs 13 while the separate `@y/codemirror` release for Yjs 14 is unstable. This matches this repo's Yjs 13 dependency. Source: [official binding README](https://github.com/yjs/y-codemirror.next).

For a future code-oriented editor, `monaco-editor` with `y-monaco` is an alternative. The official binding connects Y.Text, the Monaco model, and awareness. For this existing text demo, switching offers little benefit. Source: [y-monaco](https://github.com/yjs/y-monaco).

## Rich text

Keep Tiptap. Its Collaboration extension accepts a Y.Doc or Y.XmlFragment, which fits the existing Synixir room. Source: [Tiptap Collaboration extension](https://tiptap.dev/docs/editor/extensions/functionality/collaboration).

BlockNote is worth considering if the desired example is a block editor with ready-made menus and toolbars. It supplies React components and several UI adapters, including `@blocknote/shadcn`, and supports a configurable Yjs provider and fragment. Integration with Synixir would still need verification of the provider/awareness interface and a document-schema migration. Sources: [BlockNote setup](https://www.blocknotejs.org/docs/getting-started), [BlockNote collaboration](https://www.blocknotejs.org/docs/features/collaboration).

## Editable table

My first candidate for replacing the custom spreadsheet interactions is `react-data-grid`. Its documented features include keyboard navigation, row and column virtualization, editing, resizing, copying/pasting, and custom cell editors. A custom editor is the likely place to preserve our existing CodeMirror/Y.Text binding. This is an integration recommendation, not a tested adapter. Source: [react-data-grid features and API](https://github.com/Comcast/react-data-grid).

There is a release tradeoff: the npm `latest` version checked on 2026-09-13 is `7.0.0-beta.61`, with React and React DOM peers of `^19.2`. It matches the example's React 19.3 manifest range, but is a prerelease. Source: [published package metadata](https://registry.npmjs.org/react-data-grid/7.0.0-beta.61).

`@tanstack/react-table` is the alternative if retaining our shadcn styling and custom editors matters more than getting grid interactions. It supplies table state and APIs but leaves markup and styles to the application. Source: [TanStack Table overview](https://tanstack.com/table/v8/docs/overview).

Other candidates have specific constraints. Glide Data Grid has built-in editing, selection, and resizing, but its current `6.0.3` package declares React 16/17/18 peers, so adopting it here needs a React 19 compatibility check. AG Grid Community is free; its enhanced clipboard and range-selection features are Enterprise features. Sources: [Glide documentation](https://docs.grid.glideapps.com/), [Glide package metadata](https://registry.npmjs.org/@glideapps/glide-data-grid/6.0.3), [AG Grid editions](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/).

The local table currently binds each cell to its own Y.Text and CodeMirror instance. A grid's ordinary edit/commit callback does not by itself preserve that character-level merge behavior. Retain a Yjs-bound editor, stable row/cell IDs, remote presence, and the existing undo semantics when evaluating a replacement. Local sources: [table model](../../examples/collaboration/table/model.ts), [table UI](../../examples/collaboration/table/table.ts).

## Multiplayer form

`react-hook-form`, `@hookform/resolvers`, and `zod` can replace manual validation and form-state handling if this example becomes more complex. The resolver package documents Zod integration and inferred types. Sources: [React Hook Form](https://github.com/react-hook-form/react-hook-form), [Zod resolver](https://github.com/react-hook-form/resolvers#zod).

For this small form, I would add Zod only when the schema needs to grow, and add React Hook Form when touched/error/submission state warrants it. These packages do not establish the synchronization contract. Keep Yjs as shared state, preserve the Y.Text editor bindings, and bridge local field updates and remote observations without resetting another user's active text. This recommendation follows the local [form model](../../examples/collaboration/multiplayer-form/model.ts) and [form UI](../../examples/collaboration/multiplayer-form/form.ts).

## Scope of the findings

These recommendations combine official documentation, published package metadata, and the current source code. No replacement package was installed or tested in the application. UI packages would still use Synixir for room access, transport, durable saves, and reconnection; integration work must preserve those behaviors.
