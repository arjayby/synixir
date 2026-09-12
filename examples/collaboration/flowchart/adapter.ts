import type { Node, Edge, NodeChange, EdgeChange } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { Point, Size } from "../lib/canvas-data.ts";
import { createFlowchartModel } from "./model.ts";

export type FlowchartModel = ReturnType<typeof createFlowchartModel>;
export type FlowNode = Node<{ text: string; kind: string; color: string; readOnly: boolean }, "shape">;
export type FlowEdge = Edge<{ reciprocal: boolean }, "arrow">;
export const kindLabel = (kind: string) => ({ process: "Process", decision: "Decision", terminal: "Start / End" })[kind] ?? "Node";
type Preview = { position: Point; size: Size };

// React Flow owns transient interaction state; only completed gestures enter
// Yjs. This prevents mouse packets, measurements, and selection from becoming
// durable edits or individual undo steps.
export function createFlowchartAdapter(model: FlowchartModel) {
  let readOnly = true;
  let selectedId: string | null = null;
  let selectedEdgeId: string | null = null;
  let picking = false;
  let gesture: { id: string; initial: Preview; current: Preview; kind: "drag" | "resize" } | undefined;
  let remotePositions = new Map<string, Point>();
  const listeners = new Set<() => void>();
  const measured = new Map<string, Size>();
  const read = () => {
    const items = model.list(), connections = model.connections();
    const ids = new Set(items.map(item => item.id));
    for (const id of measured.keys()) if (!ids.has(id)) measured.delete(id);
    if (selectedId && !ids.has(selectedId)) { selectedId = null; picking = false; }
    if (selectedEdgeId && !connections.some(edge => edge.id === selectedEdgeId)) selectedEdgeId = null;
    if (gesture && !ids.has(gesture.id)) gesture = undefined;
    const nodes: FlowNode[] = items.map(item => {
      const preview = gesture?.id === item.id ? gesture.current : undefined;
      const position = preview?.position ?? remotePositions.get(item.id) ?? item.position;
      const size = preview?.size ?? item.size;
      return { id: item.id, type: "shape", position: model.boundedPosition(position, size),
        width: size.width, height: size.height, measured: measured.get(item.id), zIndex: item.order,
        data: { text: item.text, kind: item.kind, color: item.color, readOnly },
        className: `flow-node object-${item.kind} color-${item.color}`,
        ariaLabel: `${kindLabel(item.kind)}: ${item.text || "Untitled"}`,
        selected: item.id === selectedId, draggable: !readOnly && !picking, connectable: !readOnly,
      };
    });
    const edgeIds = new Set(connections.map(edge => edge.id));
    const edges: FlowEdge[] = connections.map(edge => ({ ...edge, type: "arrow", sourceHandle: "out", targetHandle: "in",
      selected: edge.id === selectedEdgeId,
      markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24 },
      data: { reciprocal: edgeIds.has(JSON.stringify([edge.target, edge.source])) },
    }));
    return { nodes, edges, items, connections, selectedId, selectedEdgeId, picking, readOnly,
      canUndo: !readOnly && model.history.canUndo(), canRedo: !readOnly && model.history.canRedo() };
  };
  let snapshot = read();
  const refresh = () => { snapshot = read(); for (const listener of listeners) listener(); };
  model.objects.observeDeep(refresh);
  model.edges.observeDeep(refresh);
  const historyEvents = ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const;
  for (const event of historyEvents) model.history.on(event, refresh);
  const selectEdge = (id: string | null) => {
    model.history.stopCapturing(); selectedId = null; selectedEdgeId = id; picking = false; refresh();
  };
  const connect = (source: string, target: string, label = "") => {
    if (readOnly) return;
    const id = model.connect(source, target, label);
    if (id) selectEdge(id);
  };
  const selectNode = (id: string | null) => {
    if (picking && selectedId && id && selectedId !== id && !readOnly) { connect(selectedId, id); return; }
    model.history.stopCapturing(); selectedId = id; selectedEdgeId = null; picking = false; refresh();
  };
  return {
    model,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    selectNode, selectEdge, connect,
    setReadOnly(value: boolean) {
      readOnly = value;
      if (value) { gesture = undefined; picking = false; }
      refresh();
    },
    setRemotePositions(positions: Map<string, Point>) { remotePositions = positions; refresh(); },
    togglePicking() { if (!readOnly) { picking = !picking; refresh(); } },
    beginGesture(id: string, kind: "drag" | "resize") {
      if (readOnly) return;
      const item = model.list().find(item => item.id === id);
      if (!item) return;
      selectedId = id; selectedEdgeId = null; picking = false;
      gesture = { id, kind, initial: { position: item.position, size: item.size }, current: { position: item.position, size: item.size } };
      model.history.stopCapturing(); refresh();
    },
    preview() { return gesture; },
    nodeChanges(changes: NodeChange<FlowNode>[]) {
      for (const change of changes) {
        // Keep measurements locally. React Flow resets handle bounds when a
        // controlled node loses its measured field, which hides its edges.
        if (change.type === "dimensions" && change.dimensions) measured.set(change.id, change.dimensions);
        // Click callbacks also handle the canvas target picker.
        if (change.type === "select" && change.selected && !picking) { selectedId = change.id; selectedEdgeId = null; }
        if (readOnly || !gesture || !("id" in change) || change.id !== gesture.id) continue;
        if (change.type === "position" && change.position) gesture.current = { ...gesture.current, position: change.position };
        if (change.type === "dimensions" && change.resizing && change.dimensions) gesture.current = { ...gesture.current, size: change.dimensions };
      }
      refresh();
    },
    edgeChanges(changes: EdgeChange<FlowEdge>[]) {
      for (const change of changes) if (change.type === "select" && change.selected) selectEdge(change.id);
    },
    finishGesture(id: string, bounds?: Preview) {
      if (readOnly || gesture?.id !== id) return;
      const completed = gesture;
      const next = bounds ?? completed.current;
      gesture = undefined;
      if (completed.kind === "drag") model.move(id, next.position);
      else {
        // A bottom/right resize must preserve a concurrent remote move.
        const moved = next.position.x !== completed.initial.position.x || next.position.y !== completed.initial.position.y;
        model.reshape(id, next.size, moved ? next.position : undefined);
      }
      refresh();
    },
    cancelGesture() { gesture = undefined; refresh(); },
    add(kind: string, position: Point) {
      if (readOnly) return;
      const id = model.add(kind, position); if (id) selectNode(id); return id;
    },
    edit(id: string, field: string, value: string) { if (!readOnly) model.edit(id, field, value); },
    label(id: string, value: string) { if (!readOnly) model.label(id, value); },
    resize(id: string, size: Size) { if (!readOnly) model.resize(id, size); },
    move(id: string, position: Point) { if (!readOnly) model.move(id, position); },
    front(id: string) { if (!readOnly) model.front(id); },
    remove(id: string) { if (!readOnly) model.remove(id); },
    disconnect(id: string) { if (!readOnly) model.disconnect(id); },
    undo() { if (!readOnly) { gesture = undefined; model.history.undo(); refresh(); } },
    redo() { if (!readOnly) { gesture = undefined; model.history.redo(); refresh(); } },
    destroy() {
      model.objects.unobserveDeep(refresh); model.edges.unobserveDeep(refresh);
      for (const event of historyEvents) model.history.off(event, refresh);
      listeners.clear(); model.destroy();
    },
  };
}
export type FlowchartAdapter = ReturnType<typeof createFlowchartAdapter>;
