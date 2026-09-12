import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createBoardModel } from "./model.ts";

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

test("cards reorder within a column and between columns without rewriting neighbors", () => {
  const { first, second, sync, close } = clients();
  try {
    const a = first.add("backlog")!;
    const b = first.add("backlog")!;
    const c = first.add("backlog")!;
    sync();
    first.move(c, "backlog", a);
    second.edit(b, "title", "Concurrent title");
    sync();
    assert.deepEqual(first.list().map(card => card.id), [c, a, b]);
    first.history.undo();
    sync();
    assert.deepEqual(first.list().map(card => card.id), [a, b, c]);
    assert.equal(first.list().find(card => card.id === b)?.title, "Concurrent title");
    first.move(b, "done", null);
    first.move(c, "done", b);
    sync();
    assert.deepEqual(first.list().filter(card => card.placement.column === "done").map(card => card.id), [c, b]);
  } finally { close(); }
});

test("concurrent equal ranks support later insertion without duplicate cards", () => {
  const { first, second, sync, close } = clients();
  try {
    first.add("backlog");
    second.add("backlog");
    sync();
    const [a, b] = first.list().map(card => card.id);
    const c = first.add("done")!;
    sync();
    first.move(c, "backlog", b);
    second.move(a, "done", null);
    sync();
    assert.deepEqual(first.list().filter(card => card.placement.column === "backlog").map(card => card.id), [c, b]);
    assert.equal(new Set(first.list().map(card => card.id)).size, 3);
  } finally { close(); }
});

test("legacy numeric placements load unchanged and remain sortable after repeated insertions", () => {
  const doc = new Y.Doc();
  const model = createBoardModel(doc);
  try {
    const legacy = (title: string) => new Y.Map<unknown>([
      ["title", title], ["description", ""], ["color", "neutral"],
      ["placement", { column: "backlog", order: 1 }],
    ]);
    model.cards.set("a", legacy("Legacy first"));
    model.cards.set("z", legacy("Legacy second"));
    assert.deepEqual(model.list().map(card => card.id), ["a", "z"]);
    let before = "z";
    for (let i = 0; i < 100; i++) {
      const id = model.add("done")!;
      model.move(id, "backlog", before);
      const ids = model.list().map(card => card.id);
      assert.equal(ids.indexOf(id), 1);
      before = id;
    }
    assert.equal(model.list().at(-1)?.id, "z");
    assert.deepEqual((model.cards.get("a") as Y.Map<unknown>).get("placement"), { column: "backlog", order: 1 });
  } finally { model.destroy(); doc.destroy(); }
});
