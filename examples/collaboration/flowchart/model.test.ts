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
