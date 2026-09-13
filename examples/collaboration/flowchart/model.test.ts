import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createFlowchartModel } from "./model.ts";

function clients() {
  const a = new Y.Doc(), b = new Y.Doc();
  const first = createFlowchartModel(a), second = createFlowchartModel(b);
  return { first, second, sync() {
    const left = Y.encodeStateAsUpdate(a), right = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, right); Y.applyUpdate(b, left);
    assert.deepEqual(first.list(), second.list());
    assert.deepEqual(first.connections(), second.connections());
  }, close() { first.destroy(); second.destroy(); a.destroy(); b.destroy(); } };
}

test("concurrent connections converge while local undo preserves another user's label", () => {
  const { first, second, sync, close } = clients();
  try {
    const start = first.add("process"), end = first.add("decision");
    sync();
    first.connect(start, end, "First"); second.connect(start, end, "Second");
    sync();
    assert.equal(first.connections().length, 1);
    const edge = first.connections()[0].id;
    first.move(start, { x: 320, y: 400 });
    second.label(edge, "Approved"); sync();
    first.history.undo(); sync();
    assert.deepEqual(first.list().find(n => n.id === start)!.position, { x: 80, y: 80 });
    assert.equal(first.connections()[0].label, "Approved");
  } finally { close(); }
});

test("deletion removes attached arrows in one undoable action; offline arrows never dangle", () => {
  const { first, second, sync, close } = clients();
  try {
    const a = first.add("terminal"), b = first.add("decision"), c = first.add("process");
    first.connect(a, b); sync();
    first.remove(b);
    second.connect(b, c, "Offline"); sync();
    assert.equal(first.list().length, 2);
    assert.equal(first.connections().length, 0);
    first.history.undo(); sync();
    assert.equal(first.list().length, 3);
    assert.equal(first.connections().length, 2);
  } finally { close(); }
});

test("arrows reject missing endpoints and self loops; reverse paths and branches stay distinct", () => {
  const { first, second, sync, close } = clients();
  try {
    const a = first.add("decision"), b = first.add("process"), c = first.add("terminal");
    assert.equal(first.connect(a, a), undefined);
    assert.equal(first.connect(a, "missing"), undefined);
    first.connect(a, b, "Yes"); first.connect(a, c, "No"); first.connect(b, a, "Retry");
    sync();
    assert.equal(second.connections().length, 3);
    const id = first.connections()[0].id;
    first.disconnect(id); sync();
    assert.equal(second.connections().length, 2);
    first.history.undo(); sync();
    assert.equal(second.connections().length, 3);
  } finally { close(); }
});

// Exercise the boundary used by React Flow rather than duplicating its drag
// implementation. Only a completed local gesture may change the document.
import { createFlowchartAdapter } from "./adapter.ts";

test("React Flow selection, measurement and drag previews never persist; one drop is one undo step", () => {
  const doc = new Y.Doc();
  const model = createFlowchartModel(doc), adapter = createFlowchartAdapter(model);
  adapter.setReadOnly(false);
  const id = adapter.add("process", { x: 80, y: 80 })!;
  let updates = 0;
  doc.on("update", () => updates++);
  adapter.selectNode(id);
  adapter.nodeChanges([{ id, type: "dimensions", dimensions: { width: 200, height: 90 } }]);
  adapter.beginGesture(id, "drag");
  for (let i = 1; i <= 100; i++) adapter.nodeChanges([{ id, type: "position", position: { x: 80 + i, y: 80 + i }, dragging: true }]);
  assert.equal(updates, 0);
  assert.deepEqual(model.list()[0].position, { x: 80, y: 80 });
  assert.deepEqual(adapter.getSnapshot().nodes[0].position, { x: 180, y: 180 });
  adapter.finishGesture(id);
  assert.equal(updates, 1);
  adapter.undo();
  assert.deepEqual(model.list()[0].position, { x: 80, y: 80 });
  assert.equal(model.list().length, 1);
  adapter.destroy(); doc.destroy();
});

test("React Flow resize commits bounds atomically and preserves concurrent text and color", () => {
  const { first, second, sync, close } = clients();
  const adapter = createFlowchartAdapter(first);
  try {
    const id = first.add("process", { x: 100, y: 100 })!; sync();
    adapter.setReadOnly(false); adapter.beginGesture(id, "resize");
    adapter.nodeChanges([{ id, type: "position", position: { x: 60, y: 70 } }, { id, type: "dimensions", resizing: true, dimensions: { width: 240, height: 120 } }]);
    second.edit(id, "text", "Remote title"); second.edit(id, "color", "rose"); sync();
    adapter.finishGesture(id); sync();
    assert.deepEqual(first.list()[0].position, { x: 60, y: 70 });
    assert.deepEqual(first.list()[0].size, { width: 240, height: 120 });
    adapter.undo(); sync();
    assert.deepEqual(first.list()[0].position, { x: 100, y: 100 });
    assert.deepEqual(first.list()[0].size, { width: 200, height: 90 });
    assert.equal(first.list()[0].text, "Remote title"); assert.equal(first.list()[0].color, "rose");
  } finally { adapter.destroy(); close(); }
});

test("React Flow bottom-right resize preserves an independent remote move", () => {
  const { first, second, sync, close } = clients();
  const adapter = createFlowchartAdapter(first);
  try {
    const id = first.add("process", { x: 100, y: 100 })!; sync();
    adapter.setReadOnly(false); adapter.beginGesture(id, "resize");
    adapter.nodeChanges([{ id, type: "dimensions", resizing: true, dimensions: { width: 300, height: 150 } }]);
    second.move(id, { x: 600, y: 400 }); sync();
    adapter.finishGesture(id); sync();
    assert.deepEqual(first.list()[0].position, { x: 600, y: 400 });
    assert.deepEqual(first.list()[0].size, { width: 300, height: 150 });
  } finally { adapter.destroy(); close(); }
});

test("React Flow read-only changes cancel pending gestures and guard every mutation", () => {
  const doc = new Y.Doc(), model = createFlowchartModel(doc), adapter = createFlowchartAdapter(model);
  const first = model.add("process")!, second = model.add("terminal")!;
  const edge = model.connect(first, second)!;
  adapter.setReadOnly(false); adapter.selectNode(first); adapter.togglePicking();
  adapter.beginGesture(first, "drag");
  adapter.nodeChanges([{ id: first, type: "position", position: { x: 400, y: 400 } }]);
  adapter.setReadOnly(true);
  const before = Y.encodeStateAsUpdate(doc);
  adapter.finishGesture(first);
  adapter.edit(first, "text", "Denied"); adapter.label(edge, "Denied");
  adapter.add("decision", { x: 100, y: 100 }); adapter.remove(first); adapter.disconnect(edge);
  adapter.move(first, { x: 300, y: 300 }); adapter.resize(first, { width: 300, height: 300 }); adapter.front(first);
  adapter.connect(second, first); adapter.undo(); adapter.redo(); adapter.togglePicking();
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(adapter.getSnapshot().picking, false);
  assert.equal(adapter.preview(), undefined);
  assert.deepEqual(adapter.getSnapshot().nodes[0].position, model.list()[0].position);
  adapter.destroy(); doc.destroy();
});
