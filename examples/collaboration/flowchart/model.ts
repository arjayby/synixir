import * as Y from "yjs";
import { canvasItem, type Point, type Size } from "../lib/canvas-data.ts";

export const canvasSize = { width: 1600, height: 1000 };
export const kinds = ["process", "decision", "terminal"];
export const colors = ["yellow", "blue", "mint", "rose", "white"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function createFlowchartModel(doc: Y.Doc) {
  const objects = doc.getMap("flowchart:nodes:v1");
  const edges = doc.getMap("flowchart:edges:v1");
  const origin = {};
  const history = new Y.UndoManager([objects, edges], { trackedOrigins: new Set([origin]) });
  function list() {
    return [...objects.entries()].map(([id, value]) => canvasItem(id, value, kinds, colors))
      .filter(item => item !== undefined)
      .map(item => ({ ...item, position: boundedPosition(item.position, item.size) }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  function boundedPosition(position: Point, size: Size) {
    return { x: clamp(position.x, 0, canvasSize.width - size.width), y: clamp(position.y, 0, canvasSize.height - size.height) };
  }
  function action(fn: () => void) {
    history.stopCapturing();
    doc.transact(fn, origin);
    history.stopCapturing();
  }
  // An edge created offline can outlive its endpoint. Keep it in the CRDT so
  // undo can restore it, but only expose edges whose endpoints still exist.
  function connections() {
    const ids = new Set(list().map(item => item.id));
    return [...edges.entries()].filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map)
      .map(([id, edge]) => ({ id, source: String(edge.get("source") ?? ""), target: String(edge.get("target") ?? ""), label: String(edge.get("label") ?? "").slice(0, 80) }))
      .filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const nextOrder = () => list().reduce((max, item) => Math.max(max, item.order), 0) + 1;
  return {
    objects, edges, history, list, connections, boundedPosition,
    add(kind: string|undefined, position = { x: 80, y: 80 }) {
      if (!kind || !kinds.includes(kind) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      const id = crypto.randomUUID();
      const size = kind === "decision" ? { width: 200, height: 160 } : { width: 200, height: 90 };
      action(() => objects.set(id, new Y.Map([
        ["kind", kind], ["text", kind === "decision" ? "A decision?" : kind === "terminal" ? "Start / End" : "New step"],
        ["color", kind === "decision" ? "yellow" : kind === "terminal" ? "mint" : "blue"],
        ["position", boundedPosition(position, size)], ["size", size], ["order", nextOrder()],
      ])));
      return id;
    },
    move(id: string|undefined, position: Point) {
      const item = objects.get(id ?? "");
      if (!(item instanceof Y.Map) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      const next = boundedPosition(position, item.get("size"));
      const previous = item.get("position");
      if (previous.x === next.x && previous.y === next.y) return;
      action(() => item.set("position", next));
    },
    resize(id: string, size: Size) {
      const item = objects.get(id ?? "");
      if (!(item instanceof Y.Map) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
      const position = item.get("position");
      const next = { width: clamp(size.width, 80, Math.min(600, canvasSize.width - position.x)),
        height: clamp(size.height, 60, Math.min(500, canvasSize.height - position.y)) };
      action(() => item.set("size", next));
    },
    edit(id: string, field: string, value: string) {
      const item = objects.get(id ?? "");
      if (!(item instanceof Y.Map) || !["text", "color"].includes(field) || typeof value !== "string") return;
      if (field === "color" && !colors.includes(value)) return;
      if (item.get(field) === value) return;
      doc.transact(() => item.set(field, field === "text" ? value.slice(0, 2000) : value), origin);
    },
    front(id: string) {
      const item = objects.get(id);
      if (item instanceof Y.Map) action(() => item.set("order", nextOrder()));
    },
    connect(source: string|undefined, target: string|undefined, label = "") {
      if (!source || !target || source === target || !objects.has(source) || !objects.has(target) || typeof label !== "string") return;
      // A deterministic key collapses concurrent creation of the same arrow.
      const id = JSON.stringify([source, target]);
      if (edges.has(id)) return id;
      action(() => edges.set(id, new Y.Map([["source", source], ["target", target], ["label", label.slice(0, 80)]])));
      return id;
    },
    label(id: string, value: string) {
      const edge = edges.get(id);
      if (edge instanceof Y.Map && typeof value === "string" && edge.get("label") !== value)
        doc.transact(() => edge.set("label", value.slice(0, 80)), origin);
    },
    disconnect(id: string) { action(() => edges.delete(id)); },
    remove(id: string|undefined) {
      action(() => {
        objects.delete(id ?? "");
        for (const [edgeId, edge] of edges) {
          if (edge instanceof Y.Map && (edge.get("source") === id || edge.get("target") === id)) edges.delete(edgeId);
        }
      });
    },
    destroy() { history.destroy(); },
  };
}
