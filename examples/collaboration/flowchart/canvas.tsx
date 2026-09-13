import { createContext, memo, useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  Background, BaseEdge, Controls, Handle, MiniMap, NodeResizer, Position, ReactFlow, ReactFlowProvider, ViewportPortal,
  useReactFlow, useViewport, useInternalNode, type Connection, type EdgeProps, type NodeProps, type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SynixirRoom } from "@synixir/client";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.tsx";
import { canvasSize, colors, createFlowchartModel } from "./model.ts";
import { connectionPath } from "./geometry.ts";
import { createFlowchartAdapter, kindLabel, type FlowchartAdapter, type FlowEdge, type FlowNode } from "./adapter.ts";
import { createFlowchartPresence, type FlowchartPresence } from "./presence.ts";

const AdapterContext = createContext<FlowchartAdapter | null>(null);
const extent: [[number, number], [number, number]] = [[0, 0], [canvasSize.width, canvasSize.height]];
const defaultViewport = { x: 0, y: 0, zoom: 1 };
const minimapStyle = { width: 120, height: 80 };
const ariaLabels = { "controls.zoomIn.ariaLabel": "Zoom in", "controls.zoomOut.ariaLabel": "Zoom out", "controls.fitView.ariaLabel": "Fit diagram" };
const announce = (message: string) => { const element = document.getElementById("board-announcement"); if (element) element.textContent = message; };
const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const adapter = useContext(AdapterContext)!;
  const onResizeStart = useCallback(() => adapter.beginGesture(id, "resize"), [adapter, id]);
  const onResizeEnd = useCallback<NonNullable<React.ComponentProps<typeof NodeResizer>["onResizeEnd"]>>((_, bounds) => {
    adapter.finishGesture(id, { position: { x: bounds.x, y: bounds.y }, size: { width: bounds.width, height: bounds.height } });
  }, [adapter, id]);
  return <>
    <NodeResizer isVisible={selected && !data.readOnly} minWidth={80} minHeight={60} maxWidth={600} maxHeight={500}
      onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />
    <div className={`flow-shape flow-shape-${data.kind}`}><span>{data.text}</span></div>
    <Handle id="in" type="target" position={Position.Left} isConnectable={!data.readOnly} aria-label="Incoming connection" />
    <Handle id="out" type="source" position={Position.Right} isConnectable={!data.readOnly} aria-label="Outgoing connection" />
  </>;
});
const ArrowEdge = memo(function ArrowEdge({ id, source, target, data, label, markerEnd, selected }: EdgeProps<FlowEdge>) {
  const from = useInternalNode(source), to = useInternalNode(target);
  if (!data || !from || !to) return null;
  const bounds = (node: typeof from) => ({ position: node.internals.positionAbsolute, size: { width: node.measured.width ?? node.width ?? 200, height: node.measured.height ?? node.height ?? 90 } });
  const { path, label: point } = connectionPath(bounds(from), bounds(to), { reciprocal: data.reciprocal, targetGap: 7 });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`flow-edge${selected ? " is-selected" : ""}`} interactionWidth={24} />
    {label ? <text className="flow-edge-label" x={point.x} y={point.y - 10}>{label}</text> : null}
  </>;
});
const nodeTypes = { shape: ShapeNode };
const edgeTypes = { arrow: ArrowEdge };

function Inspector({ adapter }: { adapter: FlowchartAdapter }) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const item = state.items.find(item => item.id === state.selectedId);
  const edge = state.connections.find(edge => edge.id === state.selectedEdgeId);
  const [target, setTarget] = useState("");
  const [branch, setBranch] = useState("");
  const targets = state.items.filter(node => node.id !== item?.id);
  const destination = targets.some(node => node.id === target) ? target : targets[0]?.id ?? "";
  const disabled = state.readOnly;
  const breakHistory = () => adapter.model.history.stopCapturing();
  return <section className="object-inspector flow-inspector" aria-label="Selected node">
    {!item && !edge ? <p id="selection-empty">Select a node to edit it, or an arrow to label a branch.</p> : null}
    {item ? <div key={item.id} id="selection-fields">
      <div className="inspector-heading"><h2>{kindLabel(item.kind)}</h2><div>
        <Button variant="outline" disabled={disabled} onClick={() => adapter.front(item.id)}>Bring to front</Button>
        <Button variant="destructive" disabled={disabled} onClick={() => adapter.remove(item.id)}>Delete node</Button>
      </div></div>
      <FieldGroup className="inspector-fields">
        <Field className="object-text-field"><FieldLabel htmlFor="object-text">Node text</FieldLabel>
          <textarea id="object-text" rows={3} maxLength={2000} placeholder="Name this step" value={item.text} readOnly={disabled}
            onFocus={breakHistory} onBlur={breakHistory} onChange={event => adapter.edit(item.id, "text", event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="object-color">Node color</FieldLabel><NativeSelect id="object-color" className="w-full" disabled={disabled} value={item.color} onChange={event => adapter.edit(item.id, "color", event.target.value)}>
          {colors.map(color => <option key={color} value={color}>{color[0].toUpperCase() + color.slice(1)}</option>)}
        </NativeSelect></Field>
        <Field><FieldLabel htmlFor="object-width">Width</FieldLabel><Input id="object-width" type="number" min={80} max={600} step={10} disabled={disabled} key={`${item.id}-w-${item.size.width}`} defaultValue={item.size.width}
          onBlur={event => adapter.resize(item.id, { ...item.size, width: event.target.valueAsNumber })} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></Field>
        <Field><FieldLabel htmlFor="object-height">Height</FieldLabel><Input id="object-height" type="number" min={60} max={500} step={10} disabled={disabled} key={`${item.id}-h-${item.size.height}`} defaultValue={item.size.height}
          onBlur={event => adapter.resize(item.id, { ...item.size, height: event.target.valueAsNumber })} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></Field>
      </FieldGroup>
      <FieldGroup className="connect-fields">
        <Field><FieldLabel htmlFor="connection-target">Connect to</FieldLabel><NativeSelect className="w-full" id="connection-target" value={destination} disabled={disabled || !destination} onChange={event => setTarget(event.target.value)}>
          {targets.map(node => <option key={node.id} value={node.id}>{node.text || kindLabel(node.kind)}</option>)}
        </NativeSelect></Field>
        <Field><FieldLabel htmlFor="connection-label">Branch label</FieldLabel><Input id="connection-label" value={branch} maxLength={80} disabled={disabled || !destination} placeholder="e.g. Yes, No, Approved" onChange={event => setBranch(event.target.value)} /></Field>
        <Button disabled={disabled || !destination} onClick={() => { adapter.connect(item.id, destination, branch); setBranch(""); announce("Nodes connected."); }}>Connect nodes</Button>
        <Button variant="outline" aria-pressed={state.picking} disabled={disabled || !destination} onClick={() => { adapter.togglePicking(); announce("Choose the next node."); }}>
          {state.picking ? "Cancel connection" : "Pick on canvas"}
        </Button>
      </FieldGroup>
    </div> : null}
    {edge ? <div id="edge-fields"><div className="inspector-heading"><h2>Connection</h2><Button variant="destructive" disabled={disabled} onClick={() => adapter.disconnect(edge.id)}>Delete connection</Button></div>
      <FieldGroup><Field><FieldLabel htmlFor="edge-label">Connection label</FieldLabel><Input id="edge-label" maxLength={80} value={edge.label} readOnly={disabled} placeholder="e.g. Yes or No"
        onFocus={breakHistory} onBlur={breakHistory} onChange={event => adapter.label(edge.id, event.target.value)} /></Field></FieldGroup>
    </div> : null}
  </section>;
}

function Presence({ adapter, presence }: { adapter: FlowchartAdapter; presence: FlowchartPresence }) {
  const { nodes } = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const peers = useSyncExternalStore(presence.subscribe, presence.getSnapshot);
  return <ViewportPortal><div className="flow-presence" aria-hidden="true">{peers.map(peer => {
    const selected = nodes.find(node => node.id === peer.selectedId);
    return <div key={peer.id}>
      {selected ? <div className="remote-selection" style={{ transform: `translate(${selected.position.x}px, ${selected.position.y}px)`, width: selected.width, height: selected.height, borderColor: peer.color }}><span style={{ background: peer.color }}>{peer.name}</span></div> : null}
      {peer.cursor ? <div className="remote-cursor" style={{ transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)`, color: peer.color }}><svg viewBox="0 0 28 28"><path d="M1.5 1.5 26.5 10.5 16 15 11 26.5Z" /></svg><span style={{ background: peer.color }}>{peer.name}</span></div> : null}
    </div>;
  })}</div></ViewportPortal>;
}

function Canvas({ adapter, presence }: { adapter: FlowchartAdapter; presence: FlowchartPresence }) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const { zoom } = useViewport();
  const viewport = useRef<HTMLDivElement>(null);
  const onConnect = useCallback((connection: Connection) => adapter.connect(connection.source, connection.target), [adapter]);
  const onDragStart = useCallback<OnNodeDrag<FlowNode>>((_, node) => adapter.beginGesture(node.id, "drag"), [adapter]);
  const onDragStop = useCallback<OnNodeDrag<FlowNode>>((_, node) => {
    adapter.finishGesture(node.id, { position: node.position, size: { width: node.width!, height: node.height! } });
  }, [adapter]);
  const onNodeClick = useCallback((_: unknown, node: FlowNode) => adapter.selectNode(node.id), [adapter]);
  const onEdgeClick = useCallback((_: unknown, edge: FlowEdge) => adapter.selectEdge(edge.id), [adapter]);
  const onPaneClick = useCallback(() => adapter.selectNode(null), [adapter]);
  const validConnection = useCallback((connection: Connection | FlowEdge) => connection.source !== connection.target, []);
  const add = (kind: string) => {
    const rect = viewport.current!.getBoundingClientRect();
    const columns = Math.max(1, Math.floor(rect.width / zoom / 260));
    const index = state.items.length;
    const position = flow.screenToFlowPosition({ x: rect.left + (50 + index % columns * 260) * zoom, y: rect.top + (60 + Math.floor(index / columns) % 3 * 180) * zoom });
    adapter.add(kind, position); announce("Node added.");
    requestAnimationFrame(() => { const text = document.getElementById("object-text") as HTMLTextAreaElement | null; text?.focus(); text?.select(); });
  };
  return <div className="flowchart-editor">
    <div className="whiteboard-tools" aria-label="Flowchart tools"><div className="object-tools">
      <Button variant="outline" data-add="process" disabled={state.readOnly} onClick={() => add("process")}>+ Process</Button>
      <Button variant="outline" data-add="decision" disabled={state.readOnly} onClick={() => add("decision")}>◇ Decision</Button>
      <Button variant="outline" data-add="terminal" disabled={state.readOnly} onClick={() => add("terminal")}>○ Start / End</Button>
    </div><output id="zoom-level" aria-label="Zoom level">{Math.round(zoom * 100)}%</output></div>
    <div ref={viewport} id="whiteboard-viewport" className={`flow-viewport${state.picking ? " is-connecting" : ""}`} aria-label="Flowchart canvas" aria-describedby="canvas-help"
      onPointerMove={event => presence.setCursor(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))}
      onPointerLeave={() => presence.setCursor(null)} onPointerCancel={() => adapter.cancelGesture()}
      onKeyDownCapture={event => {
        if (event.key === "Escape") {
          adapter.cancelGesture();
          if (state.picking) adapter.togglePicking(); else adapter.selectNode(null);
          event.stopPropagation(); return;
        }
        const focusedNode = (event.target as Element).closest<HTMLElement>(".react-flow__node");
        const focusedEdge = (event.target as Element).closest<SVGElement>(".react-flow__edge");
        if (!focusedNode && !focusedEdge) return;
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (delta) {
          event.preventDefault(); event.stopPropagation();
          const item = state.items.find(item => item.id === focusedNode?.dataset.id);
          if (item && !state.picking) { adapter.selectNode(item.id); const step = event.shiftKey ? 10 : 1; adapter.move(item.id, { x: item.position.x + delta[0] * step, y: item.position.y + delta[1] * step }); }
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault(); event.stopPropagation();
          if (focusedNode?.dataset.id) adapter.remove(focusedNode.dataset.id);
          if (focusedEdge?.dataset.id) adapter.disconnect(focusedEdge.dataset.id);
        }
      }}>
      <ReactFlow<FlowNode, FlowEdge> nodes={state.nodes} edges={state.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={adapter.nodeChanges} onEdgesChange={adapter.edgeChanges} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={onPaneClick}
        onNodeDragStart={onDragStart} onNodeDragStop={onDragStop} onConnect={onConnect} isValidConnection={validConnection}
        nodesDraggable={!state.readOnly && !state.picking} nodesConnectable={!state.readOnly} nodesFocusable edgesFocusable
        deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null} selectNodesOnDrag nodeDragThreshold={0} nodeExtent={extent}
        ariaLabelConfig={ariaLabels} defaultViewport={defaultViewport} minZoom={0.25} maxZoom={2} edgesReconnectable={false} colorMode="system">
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap style={minimapStyle} pannable zoomable />
        <Presence adapter={adapter} presence={presence} />
        {!state.nodes.length ? <Empty className="flow-empty"><EmptyHeader><EmptyTitle>Every process starts somewhere.</EmptyTitle><EmptyDescription>Add a step, then connect it to the next one.</EmptyDescription></EmptyHeader></Empty> : null}
      </ReactFlow>
    </div>
    <div className="canvas-summary"><span id="object-count" aria-live="polite">{state.items.length} {state.items.length === 1 ? "node" : "nodes"}</span>
      <span id="canvas-help">{state.picking ? "Choose the next node · Escape to cancel" : "Drag the canvas to pan · Scroll to zoom · Drag a node handle to connect"}</span>
    </div>
    <Inspector adapter={adapter} />
    <section className="flow-connections" aria-label="Flowchart connections"><h2>Connections</h2>
      {!state.connections.length ? <p>Connect two nodes to show what happens next.</p> : <ul id="connection-list">{state.connections.map(edge => {
        const title = (id: string) => state.items.find(item => item.id === id)?.text || "Untitled";
        return <li key={edge.id}><Button variant="outline" aria-pressed={state.selectedEdgeId === edge.id} onClick={() => adapter.selectEdge(edge.id)}>{title(edge.source)} → {title(edge.target)}{edge.label ? ` · ${edge.label}` : ""}</Button></li>;
      })}</ul>}
    </section>
  </div>;
}

export function createFlowchart(room: SynixirRoom) {
  const host = document.querySelector<HTMLElement>("#editor")!;
  const adapter = createFlowchartAdapter(createFlowchartModel(room.doc));
  const presence = createFlowchartPresence(room, adapter);
  const root = createRoot(host);
  root.render(<AdapterContext.Provider value={adapter}><ReactFlowProvider><Canvas adapter={adapter} presence={presence} /></ReactFlowProvider></AdapterContext.Provider>);
  const undo = document.querySelector<HTMLButtonElement>("#undo")!, redo = document.querySelector<HTMLButtonElement>("#redo")!;
  const events = new AbortController();
  undo.addEventListener("click", adapter.undo, { signal: events.signal });
  redo.addEventListener("click", adapter.redo, { signal: events.signal });
  const history = () => { undo.disabled = !adapter.getSnapshot().canUndo; redo.disabled = !adapter.getSnapshot().canRedo; };
  const unsubscribe = adapter.subscribe(history);
  host.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); if (event.shiftKey) adapter.redo(); else adapter.undo();
    }
  }, { signal: events.signal });
  history();
  function destroy() { events.abort(); unsubscribe(); root.unmount(); presence.destroy(); adapter.destroy(); }
  destroy.setReadOnly = adapter.setReadOnly;
  return destroy;
}
