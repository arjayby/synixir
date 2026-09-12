import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createTableModel } from "./model.ts";

function clients() {
  const a = new Y.Doc(), b = new Y.Doc();
  const first = createTableModel(a), second = createTableModel(b);
  const sync = () => {
    const left = Y.encodeStateAsUpdate(a), right = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, right); Y.applyUpdate(b, left);
    assert.deepEqual(first.list("rows"), second.list("rows"));
    assert.deepEqual(first.list("columns"), second.list("columns"));
    for (const row of first.list("rows")) for (const column of first.list("columns"))
      assert.equal(first.text(row.id, column.id).toString(), second.text(row.id, column.id).toString());
  };
  return { a, b, first, second, sync, close() { first.destroy(); second.destroy(); a.destroy(); b.destroy(); } };
}

test("untouched cells merge concurrent initialization and same-cell typing", () => {
  const { a, b, first, second, sync, close } = clients();
  try {
    let writes = 0; a.on("update", () => writes++);
    first.list("rows"); first.list("columns"); first.text("row-1", "column-1");
    assert.equal(writes, 0, "Opening a table does not seed document writes");
    a.transact(() => first.text("row-1", "column-1").insert(0, "Alpha "));
    b.transact(() => second.text("row-1", "column-1").insert(0, "Beta "));
    sync();
    const value = first.text("row-1", "column-1").toString();
    assert.ok(value.includes("Alpha ") && value.includes("Beta "));
  } finally { close(); }
});

test("concurrent rows survive and deleted columns stay hidden despite offline renames and cell edits", () => {
  const { first, second, sync, close } = clients();
  try {
    first.add("rows"); second.add("rows"); sync();
    assert.equal(first.list("rows").length, 5);
    first.remove("columns", "column-1");
    second.rename("column-1", "Deliverable");
    second.text("row-1", "column-1").insert(0, "Offline contribution"); sync();
    assert.equal(first.list("columns").length, 3);
    first.history.undo(); sync();
    assert.equal(first.list("columns")[0].label, "Deliverable");
    assert.equal(first.text("row-1", "column-1").toString(), "Offline contribution");
  } finally { close(); }
});

test("rectangular paste expands the table atomically and undo preserves a teammate's cell", () => {
  const { first, second, sync, close } = clients();
  try {
    assert.equal(first.paste("row-3", "column-4", "A\tB\nC\tD"), true); sync();
    assert.equal(first.list("rows").length, 4); assert.equal(first.list("columns").length, 5);
    second.text("row-1", "column-1").insert(0, "Keep me"); sync();
    first.history.undo(); sync();
    assert.equal(first.list("rows").length, 3); assert.equal(first.list("columns").length, 4);
    assert.equal(first.text("row-3", "column-4").toString(), "");
    assert.equal(first.text("row-1", "column-1").toString(), "Keep me");
    first.history.redo(); sync();
    assert.equal(first.list("rows").length, 4);
    assert.equal(first.text(first.list("rows")[3].id, first.list("columns")[4].id).toString(), "D");
    assert.equal(first.paste("row-1", "column-1", "x".repeat(50001)), false);
    assert.equal(first.paste("row-1", "column-1", Array(13).fill("x").join("\t")), false);
    assert.equal(first.list("columns").length, 5, "Rejected paste makes no partial changes");
  } finally { close(); }
});
