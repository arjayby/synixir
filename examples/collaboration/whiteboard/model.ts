import * as Y from "yjs";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { canvasItem } from "../lib/canvas-data.ts";

const ignored = new Set(["id", "version", "versionNonce", "updated", "boundElements"]);
const supported = new Set(["rectangle", "diamond", "ellipse", "text", "line", "arrow", "freedraw", "frame"]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function validElement(value: unknown): value is ExcalidrawElement {
  if (!value || typeof value !== "object") return false;
  const element = value as ExcalidrawElement;
  return typeof element.id === "string" && supported.has(element.type) &&
    [element.x, element.y, element.width, element.height].every(finite) &&
    typeof element.isDeleted === "boolean" && (element.index === null || typeof element.index === "string");
}
function validPatch(field: string, value: unknown) {
  if (["__proto__", "constructor", "prototype", "id", "boundElements", "version", "versionNonce"].includes(field)) return false;
  if (field === "position" || field === "size") {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (field === "position" ? [record.x, record.y] : [record.width, record.height]).every(finite);
  }
  if (field === "isDeleted") return typeof value === "boolean";
  if (field === "type") return typeof value === "string" && supported.has(value);
  if (field === "index") return value === null || typeof value === "string";
  if (field === "groupIds") return Array.isArray(value) && value.every(id => typeof id === "string");
  return true;
}
const key = (id: string, field: string) => JSON.stringify([id, field]);
const stable = (value: unknown) => JSON.stringify(value, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b))) : value);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// The version nonce invalidates Excalidraw's render cache after a field merge.
// A shared revision counter would itself conflict during concurrent updates.
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}
function fields(element: ExcalidrawElement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(element)) {
    if (!ignored.has(field) && !["x", "y", "width", "height"].includes(field) && value !== undefined)
      result[field] = value;
  }
  result.position = { x: element.x, y: element.y };
  result.size = { width: element.width, height: element.height };
  return result;
}

export function sameScene(a: readonly ExcalidrawElement[], b: readonly ExcalidrawElement[]) {
  return same(a.map(element => [element.id, fields(element)]), b.map(element => [element.id, fields(element)]));
}

function legacyElements(legacy: Y.Map<unknown>): ExcalidrawElement[] {
  const palette: Record<string, string> = { yellow: "#fff3bf", blue: "#a5d8ff", mint: "#b2f2bb", rose: "#ffc9c9", white: "#ffffff" };
  const items = [...legacy.entries()].map(([id, value]) => canvasItem(id, value,
    ["sticky", "rectangle", "ellipse"], Object.keys(palette)))
    .filter(item => item !== undefined).sort((a, b) => a.order - b.order || compare(a.id, b.id));
  return items.flatMap((item, index) => {
    const base = {
      id: item.id, type: item.kind === "ellipse" ? "ellipse" : "rectangle",
      ...item.position, ...item.size, strokeColor: "#1e1e1e", backgroundColor: palette[item.color],
      fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
      angle: 0, seed: hash(item.id), version: 1, versionNonce: 0, updated: 0,
      index: `a0${String(index).padStart(8, "0")}V`, isDeleted: false, groupIds: [], frameId: null,
      boundElements: null, link: null, locked: false, roundness: null,
    } as unknown as ExcalidrawElement;
    if (!item.text) return [base];
    // Stable IDs let two clients open an old room without creating duplicate labels.
    return [base, { ...base, id: `legacy-label:${item.id}`, type: "text",
      x: base.x + 12, y: base.y + 12, width: Math.max(1, base.width - 24), height: 25,
      backgroundColor: "transparent", text: item.text, originalText: item.text,
      fontSize: 20, fontFamily: 2, textAlign: "left", verticalAlign: "middle",
      containerId: item.id, autoResize: false, lineHeight: 1.25, index: `a0${String(index).padStart(8, "0")}W`,
    } as ExcalidrawElement];
  });
}

export function createWhiteboardModel(doc: Y.Doc) {
  // Creation records are immutable. Each subsequent field has its own Yjs key,
  // so a remote color edit cannot replace a local move or a different element.
  const objects = doc.getMap<ExcalidrawElement>("whiteboard:elements:v2");
  const changes = doc.getMap<unknown>("whiteboard:fields:v2");
  const legacy = doc.getMap("whiteboard:objects:v1");
  const origin = {};
  const seenIds = new Set<string>();
  const history = new Y.UndoManager([objects, changes], { trackedOrigins: new Set([origin]), captureTimeout: 500 });

  function list(): ExcalidrawElement[] {
    // Migration is a read-through projection. Opening a viewer never writes, and
    // concurrent upgrades cannot overwrite one another's first edits.
    const records = new Map(legacyElements(legacy).map(element => [element.id, element]));
    for (const [id, element] of objects) if (validElement(element) && element.id === id) records.set(id, copy(element));
    for (const id of records.keys()) seenIds.add(id);
    const fieldMaps = new Map([...records].map(([id, element]) => [id, fields(element)]));
    for (const [entry, value] of changes) {
      let parsed: unknown;
      try { parsed = JSON.parse(entry); } catch { continue; }
      if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every(part => typeof part === "string")) continue;
      const [id, field] = parsed as [string, string];
      const record = fieldMaps.get(id);
      if (record && validPatch(field, value)) record[field] = value;
    }
    const elements = [...records].map(([id, base]) => {
      const values = fieldMaps.get(id)!;
      const { position, size, ...rest } = values;
      const merged = { ...base, ...rest, ...(position as object), ...(size as object), boundElements: null } as unknown as ExcalidrawElement;
      return { ...merged, versionNonce: 0 };
    });
    const byId = new Map(elements.map(element => [element.id, element]));
    const bindings = new Map<string, { id: string; type: "arrow" | "text" }[]>();
    for (const element of elements) {
      if (element.isDeleted) continue;
      const targets = element.type === "text" ? [element.containerId] : element.type === "arrow"
        ? [element.startBinding?.elementId, element.endBinding?.elementId] : [];
      for (const target of new Set(targets)) if (target && byId.has(target)) {
        const refs = bindings.get(target) ?? [];
        refs.push({ id: element.id, type: element.type as "arrow" | "text" });
        bindings.set(target, refs);
      }
    }
    return elements.map(element => {
      const merged = { ...element, boundElements: bindings.get(element.id)?.sort((a, b) => compare(a.id, b.id)) ?? null };
      return { ...merged, versionNonce: hash(stable(merged)) };
    })
      .sort((a, b) => compare(a.index ?? "", b.index ?? "") || compare(a.id, b.id));
  }

  return {
    objects, changes, legacy, history, origin, list,
    beginGesture() { history.stopCapturing(); history.captureTimeout = Infinity; },
    endGesture() { history.captureTimeout = 500; history.stopCapturing(); },
    apply(next: readonly ExcalidrawElement[], previous: readonly ExcalidrawElement[]) {
      const before = new Map(previous.map(element => [element.id, fields(element)]));
      const known = new Set(list().map(element => element.id));
      let changed = false;
      doc.transact(() => {
        for (const element of next) {
          if (!validElement(element)) continue;
          const prior = before.get(element.id);
          if (!prior) {
            // A stale scene must not recreate an element removed by remote undo.
            if (known.has(element.id) || seenIds.has(element.id) || element.isDeleted) continue;
            objects.set(element.id, copy(element));
            seenIds.add(element.id);
            changed = true;
            continue;
          }
          if (!known.has(element.id)) continue;
          for (const [field, value] of Object.entries(fields(element))) {
            if (!same(value, prior[field])) {
              changes.set(key(element.id, field), copy(value));
              changed = true;
            }
          }
        }
        const present = new Set(next.map(element => element.id));
        for (const element of previous) if (!present.has(element.id) && known.has(element.id) && !element.isDeleted) {
          changes.set(key(element.id, "isDeleted"), true);
          changed = true;
        }
      }, origin);
      return changed;
    },
    observe(callback: (transaction: Y.Transaction) => void) {
      const handler = (_events: unknown, transaction: Y.Transaction) => callback(transaction);
      objects.observeDeep(handler); changes.observeDeep(handler); legacy.observeDeep(handler);
      return () => { objects.unobserveDeep(handler); changes.unobserveDeep(handler); legacy.unobserveDeep(handler); };
    },
    destroy() { history.destroy(); },
  };
}
