import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { api, register } from "./access-helpers.js";

async function setup(page, baseURL) {
  const user = await register(page.request, baseURL);
  const roomId = `sdk-${randomUUID()}`;
  const response = await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId });
  expect(response.ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/sdk.html?room=${roomId}` };
}
const saved = page => expect(page.locator("#sdk-state")).toHaveText("connected · saved");

function binaryPush(message) {
  if (!Buffer.isBuffer(message) || message[0] !== 0) return null;
  const [, joinSize, refSize, topicSize, eventSize] = message;
  const eventStart = 5 + joinSize + refSize + topicSize;
  return { ref: message.subarray(5 + joinSize, 5 + joinSize + refSize).toString(),
    event: message.subarray(eventStart, eventStart + eventSize).toString(),
    payload: message.subarray(eventStart + eventSize) };
}

for (const replyTiming of ["before release", "after release"]) {
  test(`public SDK sync readiness precedes durability with a reply ${replyTiming}`, async ({ page, context, baseURL }) => {
    const { url } = await setup(page, baseURL);
    const releases = [];
    const replyArrived = Promise.withResolvers();
    const deliverReply = Promise.withResolvers();
    const replyHeld = Promise.withResolvers();
    await page.routeWebSocket("**/socket/websocket**", client => {
      const server = client.connectToServer();
      const refs = new Set();
      const held = [];
      let holding = true;
      releases.push(() => {
        holding = false;
        held.splice(0).forEach(message => client.send(message));
      });
      client.onMessage(message => {
        const push = binaryPush(message);
        if (push?.event === "save_update") refs.add(push.ref);
        server.send(message);
      });
      server.onMessage(async message => {
        if (typeof message === "string") {
          const [, ref, , event] = JSON.parse(message);
          if (event === "phx_reply" && refs.delete(ref)) {
            replyArrived.resolve(message);
            await deliverReply.promise;
            if (holding) {
              held.push(message);
              replyHeld.resolve();
              return;
            }
          }
        }
        client.send(message);
      });
    });
    await page.goto(url);
    await expect(page.locator("#sdk-state")).toHaveText("connected · saving");
    // sdk.js awaits connect(): importing its exports completes while saves are held.
    expect(await page.evaluate(async () => (await import("/sdk.js")).room.state.saveStatus)).toBe("saving");
    const reply = JSON.parse(await replyArrived.promise);
    expect(reply[4]).toMatchObject({ status: "ok", response: { saved: true } });
    // Exercise both arrival orders without depending on runner or network speed.
    if (replyTiming === "before release") {
      deliverReply.resolve();
      await replyHeld.promise;
    }
    releases.forEach(release => release());
    deliverReply.resolve();
    await saved(page);
    const peer = await context.newPage();
    await peer.goto(url);
    await saved(peer);
    await page.getByLabel("Room title").fill("Shared settings");
    await expect(peer.getByLabel("Room title")).toHaveValue("Shared settings");
    await saved(page);
  });
}

test("fresh grants recover a bare SDK after a crash and overlapping disconnect/connect", async ({ page, context, baseURL, backend }) => {
  let grants = 0;
  await page.route("**/api/rooms/*/token", async route => { grants++; await route.continue(); });
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await page.getByLabel("Room title").fill("Before crash");
  await saved(page);
  const beforeRestart = grants;
  await backend.restart();
  await expect.poll(() => grants).toBeGreaterThan(beforeRestart);
  await saved(page);
  const result = await page.evaluate(async () => {
    const { room } = await import("/sdk.js");
    const closing = room.disconnect();
    room.doc.getMap("settings").set("title", "Retained offline edit");
    const first = room.connect();
    const same = first === room.connect();
    await Promise.all([closing, first]);
    return { same, connection: room.state.connection };
  });
  expect(result).toEqual({ same: true, connection: "connected" });
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await expect(peer.getByLabel("Room title")).toHaveValue("Retained offline edit");
  const beforeDestroy = grants;
  const final = await page.evaluate(async () => {
    const { room } = await import("/sdk.js");
    const connections = [];
    room.subscribe(state => connections.push(state.connection));
    await room.destroy();
    const count = connections.length;
    await room.destroy();
    const error = await room.connect().catch(error => error.code);
    return { count, finalCount: connections.length, last: connections.at(-1), error, destroyed: room.doc.isDestroyed };
  });
  expect(final.count).toBe(final.finalCount);
  expect(final).toMatchObject({ last: "destroyed", error: "destroyed", destroyed: true });
  await expect.poll(() => peer.evaluate(async () => (await import("/sdk.js")).room.awareness.getStates().size)).toBe(1);
  expect(grants).toBe(beforeDestroy);
});

test("viewer transport suppresses programmatic document writes while keeping awareness", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL);
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const response = await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: "viewer" });
    expect(response.ok()).toBe(true);
    const writes = [];
    viewer.on("websocket", ws => ws.on("framesent", ({ payload }) => {
      const push = binaryPush(payload);
      if (push?.event === "save_update" || push?.event === "transfer_chunk" ||
          (push?.event === "yjs" && push.payload[0] === 0 && [1, 2].includes(push.payload[1]))) writes.push(push.event);
    }));
    await page.goto(url);
    await saved(page);
    await viewer.goto(url);
    await expect(viewer.locator("#sdk-state")).toHaveText("connected · view-only");
    await viewer.evaluate(async () => {
      const { room } = await import("/sdk.js");
      room.doc.getMap("settings").set("title", "local viewer mutation");
      room.awareness.setLocalStateField("page", "viewer-presence");
    });
    await expect.poll(() => page.evaluate(async () => [...(await import("/sdk.js")).room.awareness.getStates().values()]
      .some(state => state.page === "viewer-presence"))).toBe(true);
    await viewer.evaluate(async () => {
      const { room } = await import("/sdk.js");
      await room.disconnect();
      await room.connect();
    });
    await expect(viewer.locator("#sdk-state")).toHaveText("connected · view-only");
    expect(writes).toEqual([]);
    await page.reload();
    await saved(page);
    await expect(page.getByLabel("Room title")).toHaveValue("");
  } finally { await viewerContext.close(); }
});
