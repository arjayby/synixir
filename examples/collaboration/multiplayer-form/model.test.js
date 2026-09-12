import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createFormModel, validate } from "./model.js";

test("form fields and separate channel choices merge, while conflicting choices converge", () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const first = createFormModel(a);
  const second = createFormModel(b);
  const sync = () => {
    const one = Y.encodeStateAsUpdate(a);
    const two = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, two);
    Y.applyUpdate(b, one);
    assert.deepEqual(first.values(), second.values());
  };
  try {
    first.texts.name.insert(0, "Project");
    sync();
    first.texts.name.insert(0, "Our ");
    second.texts.name.insert(7, " launch");
    first.set("channel:Website", true);
    second.set("channel:Email", true);
    first.set("team", "Design");
    second.set("team", "Engineering");
    second.texts.goal.insert(0, "Help teams plan");
    sync();
    assert.equal(first.values().name, "Our Project launch");
    assert.equal(first.values().goal, "Help teams plan");
    assert.deepEqual(first.values().channels, ["Website", "Email"]);
    assert.ok(["Design", "Engineering"].includes(first.values().team));
    first.set("priority", "High");
    second.set("date", "2027-06-15");
    sync();
    first.history.undo();
    sync();
    assert.equal(first.values().priority, "Normal");
    assert.equal(first.values().date, "2027-06-15");
  } finally { first.destroy(); second.destroy(); a.destroy(); b.destroy(); }
});

test("validation preserves incomplete drafts and checks text lengths and dates", () => {
  const doc = new Y.Doc();
  const model = createFormModel(doc);
  try {
    assert.deepEqual(Object.keys(validate(model.values())), ["name", "goal", "audience", "team"]);
    model.texts.name.insert(0, "N".repeat(121));
    model.set("date", "2027-02-30");
    model.set("team", "Invalid team");
    model.set("channel:Website", "true");
    assert.equal(model.values().date, "");
    assert.equal(model.values().team, "");
    assert.deepEqual(model.values().channels, []);
    assert.equal(validate(model.values()).name, "Use 120 characters or fewer.");
    assert.equal(model.texts.name.length, 121);
    model.set("date", "2028-02-29");
    assert.equal(model.values().date, "2028-02-29");
  } finally { model.destroy(); doc.destroy(); }
});
