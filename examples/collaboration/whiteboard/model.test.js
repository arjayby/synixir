import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createWhiteboardModel, canvasSize } from "./model.js";

function clients() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const first = createWhiteboardModel(a);
  const second = createWhiteboardModel(b);
  return { first, second, sync() {
    const left = Y.encodeStateAsUpdate(a);
    const right = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, right);
    Y.applyUpdate(b, left);
    assert.deepEqual(first.list(), second.list());
  }, close() { first.destroy(); second.destroy(); a.destroy(); b.destroy(); } };
}

test("concurrent moves choose one position while a teammate's text survives undo", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("sticky");
    sync();
    first.move(id, { x: 300, y: 200 });
    second.edit(id, "text", "A teammate's idea");
    sync();
    first.history.undo();
    sync();
    assert.deepEqual(first.list()[0].position, { x: 80, y: 80 });
    assert.equal(first.list()[0].text, "A teammate's idea");
    first.move(id, { x: 200, y: 100 });
    second.move(id, { x: 500, y: 400 });
    sync();
    assert.equal(first.list().length, 1);
    assert.ok([200, 500].includes(first.list()[0].position.x));
  } finally { close(); }
});

test("objects stay within the canvas and concurrent creation preserves both objects", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("rectangle", { x: -100, y: 9000 });
    second.add("ellipse");
    sync();
    assert.equal(first.list().length, 2);
    first.move(id, { x: 9999, y: 9999 });
    first.resize(id, { width: 500, height: 500 });
    sync();
    const item = first.list().find(item => item.id === id);
    assert.ok(item.position.x + item.size.width <= canvasSize.width);
    assert.ok(item.position.y + item.size.height <= canvasSize.height);
  } finally { close(); }
});

test("deletion wins over an offline edit and undo restores the object", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("sticky");
    sync();
    first.remove(id);
    second.edit(id, "color", "rose");
    sync();
    assert.equal(first.list().length, 0);
    first.history.undo();
    sync();
    assert.equal(first.list().length, 1);
    assert.equal(first.list()[0].kind, "sticky");
  } finally { close(); }
});
