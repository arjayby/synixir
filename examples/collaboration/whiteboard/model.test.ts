import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createWhiteboardModel } from "./model.ts";

function shape(id = crypto.randomUUID()): ExcalidrawElement {
  return { id, type: "rectangle", x: 80, y: 80, width: 220, height: 180,
    angle: 0, strokeColor: "#000000", backgroundColor: "#ffffff", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roundness: null, roughness: 0, opacity: 100,
    seed: 1, version: 1, versionNonce: 1, index: "a0", isDeleted: false,
    groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false,
  } as unknown as ExcalidrawElement;
}
function clients() {
  const a = new Y.Doc(), b = new Y.Doc();
  const first = createWhiteboardModel(a), second = createWhiteboardModel(b);
  return { a, b, first, second, sync() {
    const left = Y.encodeStateAsUpdate(a), right = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, right); Y.applyUpdate(b, left);
    assert.deepEqual(first.list(), second.list());
  }, close() { first.destroy(); second.destroy(); a.destroy(); b.destroy(); } };
}
function edit(model: ReturnType<typeof createWhiteboardModel>, id: string, patch: Partial<ExcalidrawElement>) {
  const before = model.list();
  model.history.stopCapturing();
  model.apply(before.map(element => element.id === id ? { ...element, ...patch } as ExcalidrawElement : element), before);
  model.history.stopCapturing();
}

test("concurrent element creation, field edits, and local undo preserve remote work", () => {
  const c = clients();
  try {
    const left = shape(), right = shape();
    c.first.apply([left], []); c.second.apply([right], []); c.sync();
    assert.equal(c.first.list().length, 2);
    edit(c.first, left.id, { x: 300, y: 200 });
    edit(c.second, left.id, { backgroundColor: "#b2f2bb" }); c.sync();
    assert.equal(c.first.list().find(e => e.id === left.id)?.x, 300);
    c.first.history.undo(); c.sync();
    const restored = c.first.list().find(e => e.id === left.id)!;
    assert.equal(restored.x, 80);
    assert.equal(restored.backgroundColor, "#b2f2bb");
    c.first.history.redo(); c.sync();
    assert.equal(c.first.list().find(e => e.id === left.id)?.x, 300);
  } finally { c.close(); }
});

test("concurrent moves converge to one complete position and preserve a resize", () => {
  const c = clients();
  try {
    const element = shape(); c.first.apply([element], []); c.sync();
    edit(c.first, element.id, { x: 300, y: 200 });
    edit(c.second, element.id, { x: 400, y: 500, width: 300 }); c.sync();
    const merged = c.first.list()[0];
    assert.ok((merged.x === 300 && merged.y === 200) || (merged.x === 400 && merged.y === 500));
    assert.equal(merged.width, 300);
  } finally { c.close(); }
});

test("deletion wins over an offline edit; undo restores the edited element", () => {
  const c = clients();
  try {
    const element = shape(); c.first.apply([element], []); c.sync();
    const stale = c.second.list();
    edit(c.first, element.id, { isDeleted: true });
    edit(c.second, element.id, { backgroundColor: "#ffc9c9" }); c.sync();
    assert.equal(c.first.list()[0].isDeleted, true);
    // A queued callback from a stale canvas must not revive the deletion.
    c.second.apply(stale.map(e => ({ ...e, width: 400 })), stale); c.sync();
    assert.equal(c.first.list()[0].isDeleted, true);
    c.first.history.undo(); c.sync();
    assert.equal(c.first.list()[0].isDeleted, false);
    assert.equal(c.first.list()[0].backgroundColor, "#ffc9c9");
    assert.equal(c.first.list()[0].width, 400);
  } finally { c.close(); }
});

test("scene observations do not echo metadata or create undo entries", () => {
  const c = clients();
  try {
    c.first.apply([shape()], []); c.sync();
    const before = c.second.list();
    const vector = Y.encodeStateVector(c.b);
    assert.equal(c.second.apply(before.map(e => ({ ...e, version: 900, versionNonce: 12, updated: Date.now() })), before), false);
    assert.deepEqual(Y.encodeStateVector(c.b), vector);
    assert.equal(c.second.history.canUndo(), false);
  } finally { c.close(); }
});

test("concurrent arrow bindings retain both references and deleted arrows detach", () => {
  const c = clients();
  try {
    const target = shape(); c.first.apply([target], []); c.sync();
    const arrow = (id: string) => ({ ...shape(id), type: "arrow", points: [[0, 0], [100, 100]],
      startBinding: null, endBinding: { elementId: target.id, focus: 0, gap: 1 },
      startArrowhead: null, endArrowhead: "arrow", elbowed: false } as unknown as ExcalidrawElement);
    c.first.apply([...c.first.list(), arrow("left")], c.first.list());
    c.second.apply([...c.second.list(), arrow("right")], c.second.list()); c.sync();
    assert.deepEqual(c.first.list().find(e => e.id === target.id)?.boundElements?.map(e => e.id).sort(), ["left", "right"]);
    edit(c.first, "left", { isDeleted: true }); c.sync();
    assert.deepEqual(c.first.list().find(e => e.id === target.id)?.boundElements, [{ id: "right", type: "arrow" }]);
  } finally { c.close(); }
});

test("v1 migration is deterministic, read only, and merges concurrent first edits", () => {
  const c = clients();
  try {
    c.a.getMap("whiteboard:objects:v1").set("old-note", new Y.Map<unknown>([
      ["kind", "sticky"], ["text", "Keep this idea"], ["position", { x: 100, y: 150 }],
      ["size", { width: 220, height: 180 }], ["order", 1], ["color", "mint"],
    ])); c.sync();
    const vector = Y.encodeStateVector(c.a);
    assert.equal(c.first.list().length, 2);
    assert.equal(c.first.list().find(e => e.type === "text")?.text, "Keep this idea");
    assert.deepEqual(Y.encodeStateVector(c.a), vector);
    assert.equal(c.first.history.canUndo(), false);
    edit(c.first, "old-note", { x: 400 });
    edit(c.second, "old-note", { backgroundColor: "#ffc9c9" }); c.sync();
    const migrated = c.first.list().find(e => e.id === "old-note")!;
    assert.equal(migrated.x, 400);
    assert.equal(migrated.backgroundColor, "#ffc9c9");
    assert.equal(c.first.list().length, 2);
  } finally { c.close(); }
});

test("a pointer gesture is one undo item and unsupported asset records are ignored", () => {
  const c = clients();
  try {
    const element = shape(); c.first.apply([element], []); c.first.history.stopCapturing();
    c.first.beginGesture();
    for (const x of [100, 150, 300]) {
      const before = c.first.list();
      c.first.apply(before.map(e => ({ ...e, x })), before);
    }
    c.first.endGesture(); c.first.history.undo();
    assert.equal(c.first.list()[0].x, 80);
    c.first.apply([...c.first.list(), { ...shape(), type: "image" } as ExcalidrawElement], c.first.list());
    assert.equal(c.first.list().length, 1);
  } finally { c.close(); }
});

test("fractional ranks use raw lexical ordering and malformed shared records are ignored", () => {
  const doc = new Y.Doc(), model = createWhiteboardModel(doc);
  try {
    const upper = { ...shape("upper"), index: "a0Z" } as ExcalidrawElement;
    const lower = { ...shape("lower"), index: "a0a" } as ExcalidrawElement;
    model.apply([lower, upper], []);
    doc.getMap<unknown>("whiteboard:elements:v2").set("invalid", null);
    doc.getMap<unknown>("whiteboard:fields:v2").set("invalid JSON", true);
    doc.getMap<unknown>("whiteboard:fields:v2").set("null", true);
    doc.getMap<unknown>("whiteboard:fields:v2").set(JSON.stringify(["lower", "position"]), null);
    assert.deepEqual(model.list().map(e => e.id), ["upper", "lower"]);
    assert.equal(model.list()[1].x, 80);
  } finally { model.destroy(); doc.destroy(); }
});

test("late scene callbacks cannot recreate an object after its creator undoes it", () => {
  const c = clients();
  try {
    const element = shape();
    c.first.apply([element], []); c.sync();
    const stale = c.second.list();
    c.first.history.undo(); c.sync();
    assert.equal(c.second.list().length, 0);
    c.second.apply(stale.map(e => ({ ...e, x: 500 })), []); c.sync();
    assert.equal(c.first.list().length, 0);
  } finally { c.close(); }
});
