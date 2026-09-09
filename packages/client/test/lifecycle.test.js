import { test } from "node:test";
import assert from "node:assert/strict";
import { SynixirRoom, SynixirError } from "@synixir/client";
import * as Y from "yjs";

const options = { roomId: "sdk-unit", userId: "account-id", serverUrl: "http://127.0.0.1:4010" };
const tick = () => new Promise(resolve => setImmediate(resolve));

// These run through the package entry point without browser globals or a server.
test("validates options before allocating a document or awareness timer", () => {
  for (const roomId of ["", "bad/id", "_invalid", "x".repeat(129), 123]) {
    assert.throws(() => new SynixirRoom({ ...options, roomId }), TypeError);
  }
  assert.throws(() => new SynixirRoom({ ...options, userId: "" }), TypeError);
  assert.throws(() => new SynixirRoom({ ...options, serverUrl: "https://example.com/prefix" }), TypeError);
  assert.throws(() => new SynixirRoom({ ...options, getAccess: true }), TypeError);
});

test("owns one shared Yjs document and exposes immutable snapshots with unsubscribe", async () => {
  const room = new SynixirRoom(options);
  const states = [];
  const unsubscribe = room.subscribe(state => states.push(state));
  try {
    assert.ok(room.doc instanceof Y.Doc);
    assert.equal(room.awareness.doc, room.doc);
    assert.equal(states.length, 1);
    assert.ok(Object.isFrozen(states[0]));
    room.doc.getText("content").insert(0, "offline draft");
    assert.equal(room.state.saveStatus, "unsaved");
    assert.equal(room.state.hasUnsavedChanges, true);
    assert.equal(states[0].saveStatus, "not-saved");
    unsubscribe();
    const count = states.length;
    room.doc.getText("content").insert(0, "more ");
    assert.equal(states.length, count);
    await room.disconnect();
    assert.equal(room.doc.getText("content").toString(), "more offline draft");
  } finally { await room.destroy(); }
});

test("coalesces connects, aborts pending access, and ignores a late old result", async () => {
  const requests = [];
  const room = new SynixirRoom({ ...options, getAccess: request => new Promise(resolve => {
    requests.push({ ...request, resolve });
  }) });
  try {
    const first = room.connect();
    const rejected = assert.rejects(first, { code: "disconnected" });
    assert.equal(first, room.connect());
    assert.equal(requests.length, 1);
    await room.disconnect();
    await rejected;
    assert.equal(requests[0].signal.aborted, true);
    const second = room.connect();
    const destroyed = assert.rejects(second, { code: "destroyed" });
    requests[0].resolve({ token: "stale", userId: "another-account", role: "owner" });
    await tick();
    assert.equal(room.state.connection, "connecting");
    assert.equal(room.state.error, null);
    await room.destroy();
    await destroyed;
    assert.equal(requests[1].signal.aborted, true);
    requests[1].resolve({ token: "late", userId: options.userId, role: "owner" });
    await tick();
    assert.equal(room.state.connection, "destroyed");
    assert.ok(room.doc.isDestroyed);
    assert.equal(room.awareness.getLocalState(), null);
    await assert.rejects(room.connect(), { code: "destroyed" });
  } finally { await room.destroy(); }
});

test("account mismatch freezes the retained draft and never requests access again", async () => {
  let calls = 0;
  const room = new SynixirRoom({ ...options, getAccess: async () => {
    calls++;
    return { token: "wrong-account", userId: "someone-else", role: "owner" };
  } });
  try {
    room.doc.getText("content").insert(0, "private draft");
    await assert.rejects(room.connect(), { code: "account_changed" });
    await room.disconnect();
    await assert.rejects(room.connect(), { code: "account_changed" });
    assert.equal(calls, 1);
    assert.equal(room.state.readOnly, true);
    assert.equal(room.doc.getText("content").toString(), "private draft");
  } finally { await room.destroy(); }
});

test("nonretryable access errors permit explicit retry and reject malformed grants", async () => {
  let calls = 0;
  const room = new SynixirRoom({ ...options, getAccess: async () => {
    if (++calls === 1) throw new SynixirError("unauthorized");
    return { token: "grant", userId: options.userId, role: "admin" };
  } });
  try {
    await assert.rejects(room.connect(), { code: "unauthorized" });
    assert.equal(room.state.connection, "error");
    await assert.rejects(room.connect(), { code: "invalid_access" });
    assert.equal(calls, 2);
  } finally { await room.destroy(); }
});

test("destroy cancels scheduled recovery and subscriptions stop after final state", async () => {
  let calls = 0;
  const room = new SynixirRoom({ ...options, getAccess: async () => {
    calls++;
    throw new SynixirError("offline", { retryable: true });
  } });
  const states = [];
  room.subscribe(state => states.push(state.connection));
  await assert.rejects(room.connect(), { code: "offline" });
  assert.equal(room.state.connection, "reconnecting");
  await room.destroy();
  const count = states.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  await room.disconnect();
  await room.destroy();
  assert.equal(calls, 1);
  assert.equal(states.length, count);
  assert.equal(states.at(-1), "destroyed");
});

test("a subscriber can cancel a new attempt before any access request starts", async () => {
  let calls = 0;
  const room = new SynixirRoom({ ...options, getAccess: async () => {
    calls++;
    throw new SynixirError("should_not_run");
  } });
  room.subscribe(state => {
    if (state.connection === "connecting") void room.destroy();
  });
  await assert.rejects(room.connect(), { code: "destroyed" });
  await tick();
  assert.equal(calls, 0);
  assert.equal(room.state.connection, "destroyed");
});

test("access timeout settles a callback that ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const room = new SynixirRoom({ ...options, getAccess: request => {
    signal = request.signal;
    return new Promise(() => {});
  } });
  try {
    const connecting = assert.rejects(room.connect(), { code: "timeout", retryable: true });
    t.mock.timers.tick(10_000);
    await connecting;
    assert.equal(signal.aborted, true);
    assert.equal(room.state.connection, "reconnecting");
  } finally { await room.destroy(); }
});
