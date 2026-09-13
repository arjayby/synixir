import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createFormModel, validate } from "./model.ts";
import { createBriefFormState } from "./form-state.ts";

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

test("form state validates a shared draft without writing to Yjs or marking remote fields touched", async () => {
  const doc = new Y.Doc();
  const peerDoc = new Y.Doc();
  const model = createFormModel(doc);
  const peer = createFormModel(peerDoc);
  const form = createBriefFormState(doc, model);
  const sync = () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc));
  try {
    peer.texts.name.insert(0, "N".repeat(121));
    sync();
    assert.equal(form.control.getValues("name"), "N".repeat(121));
    assert.equal(form.control.getFieldState("name").isTouched, false);
    assert.equal(form.control.getFieldState("name").isDirty, false);
    assert.equal(form.control.getFieldState("name").error, undefined);
    form.touch("name");
    await form.control.trigger("name");
    assert.equal(form.control.getFieldState("name").error?.message, "Use 120 characters or fewer.");
    assert.equal(model.texts.name.length, 121);
    peerDoc.transact(() => {
      peer.texts.name.delete(0, 121);
      peer.texts.name.insert(0, "  Our launch  ");
      peer.texts.goal.insert(0, "Plan together");
      peer.texts.audience.insert(0, "Product teams");
      peer.set("team", "Product");
    });
    sync();
    await form.control.trigger();
    assert.equal(form.control.getFieldState("name").error, undefined);
    assert.equal(form.control.getFieldState("name").isTouched, true);
    assert.equal(form.control.getFieldState("goal").isTouched, false);
    const before = Y.encodeStateAsUpdate(doc);
    let reviewed = false;
    await form.control.handleSubmit(values => {
      reviewed = true;
      assert.equal(values.name, "  Our launch  ");
    })();
    assert.equal(reviewed, true);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally {
    form.destroy(); model.destroy(); peer.destroy(); doc.destroy(); peerDoc.destroy();
  }
});

test("review schema rejects malformed choices and impossible dates", () => {
  const valid = { name: "Launch", goal: "Plan together", audience: "Teams", team: "Product", date: "2028-02-29", priority: "Normal", channels: ["Website"] };
  assert.deepEqual(validate(valid), {});
  assert.deepEqual(validate({ ...valid, date: "2027-02-29", priority: "Now", channels: ["Unknown"] }), {
    date: "Choose a valid date.", priority: "Choose a priority.", channels: "Choose a launch channel.",
  });
  assert.equal(validate({ ...valid, name: "   " }).name, "Project name is required.");
});
