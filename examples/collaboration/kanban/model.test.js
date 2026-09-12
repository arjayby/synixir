import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createBoardModel } from "./model.js";

function clients() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const first = createBoardModel(a);
  const second = createBoardModel(b);
  const sync = () => {
    const updateA = Y.encodeStateAsUpdate(a);
    const updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB);
    Y.applyUpdate(b, updateA);
    assert.deepEqual(first.list(), second.list());
  };
  return { first, second, sync, close() { first.destroy(); second.destroy(); a.destroy(); b.destroy(); } };
}

test("concurrent moves converge to one placement and independent fields survive", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("backlog");
    sync();
    first.move(id, "in-progress");
    first.edit(id, "title", "Ship the board");
    second.move(id, "done");
    second.edit(id, "description", "Reviewed by the team");
    sync();
    assert.equal(first.list().length, 1);
    assert.equal(first.list()[0].title, "Ship the board");
    assert.equal(first.list()[0].description, "Reviewed by the team");
    assert.ok(["in-progress", "done"].includes(first.list()[0].placement.column));
  } finally { close(); }
});

test("undo of a local move preserves a remote edit; deletion and restoration synchronize", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("backlog");
    sync();
    first.move(id, "done");
    second.edit(id, "title", "A teammate's title");
    sync();
    first.history.undo();
    sync();
    assert.equal(first.list()[0].placement.column, "backlog");
    assert.equal(first.list()[0].title, "A teammate's title");
    first.remove(id);
    sync();
    assert.equal(second.list().length, 0);
    first.history.undo();
    sync();
    assert.equal(second.list()[0].title, "A teammate's title");
  } finally { close(); }
});

test("concurrent creation keeps both cards and deletion wins over an offline field edit", () => {
  const { first, second, sync, close } = clients();
  try {
    const id = first.add("backlog");
    second.add("backlog");
    sync();
    assert.equal(first.list().length, 2);
    first.remove(id);
    second.edit(id, "title", "Offline draft");
    sync();
    assert.equal(first.list().length, 1);
    assert.ok(first.list().every(card => card.id !== id));
  } finally { close(); }
});
