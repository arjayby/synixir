import * as Y from "yjs";
import { canvasItem, type Point, type Size } from "../lib/canvas-data.ts";

export const canvasSize = { width: 1600, height: 1000 };
export const kinds = ["sticky", "rectangle", "ellipse"];
export const colors = ["yellow", "blue", "mint", "rose", "white"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function createWhiteboardModel(doc: Y.Doc) {
  const objects = doc.getMap("whiteboard:objects:v1");
  const origin = {};
  const history = new Y.UndoManager(objects, { trackedOrigins: new Set([origin]) });
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
  const nextOrder = () => list().reduce((max, item) => Math.max(max, item.order), 0) + 1;
  return {
    objects, history, list, boundedPosition,
    add(kind: string|undefined, position = { x: 80, y: 80 }) {
      if (!kind || !kinds.includes(kind) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      const id = crypto.randomUUID();
      const size = kind === "sticky" ? { width: 220, height: 180 } : { width: 240, height: 140 };
      action(() => objects.set(id, new Y.Map([
        ["kind", kind], ["text", kind === "sticky" ? "New idea" : ""],
        ["color", kind === "sticky" ? "yellow" : "blue"],
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
    resize(id: string|undefined, size: Size) {
      const item = objects.get(id ?? "");
      if (!(item instanceof Y.Map) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
      const position = item.get("position");
      const next = { width: clamp(size.width, 80, Math.min(600, canvasSize.width - position.x)),
        height: clamp(size.height, 60, Math.min(500, canvasSize.height - position.y)) };
      action(() => item.set("size", next));
    },
    edit(id: string|undefined, field: string, value: string) {
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
    remove(id: string|undefined) { action(() => objects.delete(id ?? "")); },
    destroy() { history.destroy(); },
  };
}
