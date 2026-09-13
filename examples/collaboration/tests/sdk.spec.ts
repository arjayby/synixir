import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Page } from "@playwright/test";

async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `sdk-${randomUUID()}`;
  const response = await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId });
  expect(response.ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/?room=${roomId}` };
}
// Exercise the SDK through the text example without relying on a dedicated demo page.
async function state(page: Page, saveStatus: string) {
  await expect(page.locator("#status")).toHaveText("Connected");
  await expect(page.locator("#save-status")).toHaveText(saveStatus);
}
const saved = (page: Page) => state(page, "Saved");
async function setTitle(page: Page, title: string) {
  await page.evaluate(value => window.synixirTest.room!.doc.getMap("sdk-test").set("title", value), title);
}
async function expectTitle(page: Page, title: string) {
  await expect.poll(() => page.evaluate(() => window.synixirTest.room!.doc.getMap("sdk-test").get("title") ?? "")).toBe(title);
}

function binaryPush(message: string|number[]|Buffer<ArrayBufferLike>|[any,any,any,any,any]) {
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
    const releases: (() => void)[] = [];
    const replyArrived = Promise.withResolvers<string>();
    const deliverReply = Promise.withResolvers<void>();
    const replyHeld = Promise.withResolvers<void>();
    await page.routeWebSocket("**/socket/websocket**", client => {
      const server = client.connectToServer();
      const refs = new Set();
      const held: string[] = [];
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
    await state(page, "Saving");
    // Synchronization is ready while the durable save acknowledgement is held.
    expect(await page.evaluate(async () => window.synixirTest.room!.state.saveStatus)).toBe("saving");
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
    await setTitle(page, "Shared value");
    await expectTitle(peer, "Shared value");
    await saved(page);
  });
}

test("fresh grants recover the SDK after a crash and overlapping disconnect/connect", async ({ page, context, baseURL, backend }) => {
  let grants = 0;
  await page.route("**/api/rooms/*/token", async route => { grants++; await route.continue(); });
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await setTitle(page, "Before crash");
  await saved(page);
  const beforeRestart = grants;
  await backend.restart();
  await expect.poll(() => grants).toBeGreaterThan(beforeRestart);
  await saved(page);
  const result = await page.evaluate(async () => {
    const room = window.synixirTest.room!;
    const closing = room.disconnect();
    room.doc.getMap("sdk-test").set("title", "Retained offline edit");
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
  await expectTitle(peer, "Retained offline edit");
  const beforeDestroy = grants;
  const final = await page.evaluate(async () => {
    const room = window.synixirTest.room!;
    const connections: any[] = [];
    room.subscribe((state: { connection: any; }) => connections.push(state.connection));
    await room.destroy();
    const count = connections.length;
    await room.destroy();
    const error = await room.connect().catch((error: { code: any; }) => error.code);
    return { count, finalCount: connections.length, last: connections.at(-1), error, destroyed: room.doc.isDestroyed };
  });
  expect(final.count).toBe(final.finalCount);
  expect(final).toMatchObject({ last: "destroyed", error: "destroyed", destroyed: true });
  await expect.poll(() => peer.evaluate(async () => window.synixirTest.room!.awareness.getStates().size)).toBe(1);
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
    const writes: any[] = [];
    viewer.on("websocket", ws => ws.on("framesent", ({ payload }) => {
      const push = binaryPush(payload);
      if (push?.event === "save_update" || push?.event === "transfer_chunk" ||
          (push?.event === "yjs" && push.payload[0] === 0 && [1, 2].includes(push.payload[1]))) writes.push(push.event);
    }));
    await page.goto(url);
    await saved(page);
    await viewer.goto(url);
    await state(viewer, "View only");
    await viewer.evaluate(async () => {
      const room = window.synixirTest.room!;
      room.doc.getMap("sdk-test").set("title", "local viewer mutation");
      room.awareness.setLocalStateField("page", "viewer-presence");
    });
    await expect.poll(() => page.evaluate(async () => [...window.synixirTest.room!.awareness.getStates().values()]
      .some(state => state.page === "viewer-presence"))).toBe(true);
    await viewer.evaluate(async () => {
      const room = window.synixirTest.room!;
      await room.disconnect();
      await room.connect();
    });
    await state(viewer, "View only");
    expect(writes).toEqual([]);
    await page.reload();
    await saved(page);
    await expectTitle(page, "");
  } finally { await viewerContext.close(); }
});
