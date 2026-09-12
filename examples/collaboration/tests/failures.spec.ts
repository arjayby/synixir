import { openRoom } from "./access-helpers.ts";
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { editor, expectText, insertAtStart, connected } from "./editor-helpers.ts";

// Phoenix's binary push header contains the join ref, request ref, topic and
// event. Requests still reach the real backend; only their replies are held.
function binaryPush(message: string|number[]|Buffer<ArrayBufferLike>|[any,any,any,any,any]) {
  if (!Buffer.isBuffer(message) || message[0] !== 0) return null;
  const [, joinSize, refSize, topicSize, eventSize] = message;
  const refStart = 5 + joinSize;
  const eventStart = refStart + refSize + topicSize;
  return {
    ref: message.subarray(refStart, refStart + refSize).toString(),
    event: message.subarray(eventStart, eventStart + eventSize).toString(),
  };
}

test("missing save acknowledgements never show Saved and reconnect confirms the edits", async ({ page, baseURL }) => {
  let holdReplies = false;
  let releaseReplies = () => {};
  await page.routeWebSocket("**/socket/websocket**", client => {
    const server = client.connectToServer();
    const refs = new Set();
    const held: string[] = [];
    releaseReplies = () => { held.splice(0).forEach(message => client.send(message)); };
    client.onMessage(message => {
      const push = binaryPush(message);
      if (holdReplies && push?.event === "save_update") refs.add(push.ref);
      server.send(message);
    });
    server.onMessage(message => {
      if (typeof message === "string") {
        const [, ref, , event] = JSON.parse(message);
        if (event === "phx_reply" && refs.has(ref)) {
          held.push(message);
          return;
        }
      }
      client.send(message);
    });
  });
  await openRoom(page, `${baseURL}/?room=lost-ack-${randomUUID()}`);
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  holdReplies = true;
  await insertAtStart(page, "First edit");
  await expect(page.locator("#save-status")).toHaveText("Saving");
  holdReplies = false;
  await insertAtStart(page, "Second edit. ");
  // Confirming a later revision must not hide the missing earlier reply.
  await expect(page.locator("#save-status")).toHaveText("Saving");
  await expect(page.locator("#save-status")).toHaveText("Save failed", { timeout: 15_000 });
  await expect(page.locator("#save-help")).toContainText("acknowledgement did not arrive");
  // A late acknowledgement after the request timed out cannot confirm it.
  releaseReplies();
  await expect(page.locator("#save-status")).toHaveText("Save failed");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  holdReplies = false;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.reload();
  await expectText(page, "Second edit. First edit");
});

test("reconnect fetches fresh access and rejected joins retain local edits", async ({ page, baseURL, backend }) => {
  let reject = true;
  let requests = 0;
  await page.route("**/api/rooms/*/token", async route => {
    requests++;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.routeWebSocket("**/socket/websocket**", client => {
    const server = client.connectToServer();
    client.onMessage(message => {
      if (reject && typeof message === "string") {
        const payload = JSON.parse(message);
        if (payload[3] === "phx_join") {
          payload[4].token += "tampered";
          return server.send(JSON.stringify(payload));
        }
      }
      server.send(message);
    });
  });
  await openRoom(page, `${baseURL}/?room=access-retry-${randomUUID()}`);
  await expect(page.locator("#status")).toHaveText("Access expired or denied");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await insertAtStart(page, "Keep my local draft");
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  expect(requests).toBe(1);
  reject = false;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  expect(requests).toBe(2);
  reject = true;
  await backend.restart();
  await expect(page.locator("#status")).toHaveText("Access expired or denied");
  await insertAtStart(page, "After reconnect. ");
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  expect(requests).toBe(3);
  reject = false;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.reload();
  await expectText(page, "After reconnect. Keep my local draft");
  expect(requests).toBe(5); // Manual retry and the final page reload both fetch new grants.
});

test("a client without chunk support still rejects oversized messages", async ({ page, context, baseURL }) => {
  await page.routeWebSocket("**/socket/websocket**", client => {
    const server = client.connectToServer();
    client.onMessage(message => {
      if (typeof message === "string") {
        const payload = JSON.parse(message);
        if (payload[3] === "phx_join") {
          delete payload[4].chunked_sync;
          return server.send(JSON.stringify(payload));
        }
      }
      server.send(message);
    });
  });
  const url = `${baseURL}/?room=oversized-${randomUUID()}`;
  await openRoom(page, url);
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await editor(page).click();
  await page.keyboard.insertText("x".repeat(1_048_577));
  await expect(page.locator("#save-status")).toHaveText("Save failed");
  await expect(page.locator("#save-help")).toContainText("exceeds the transfer limit");
  await page.close();
  const reader = await context.newPage();
  await openRoom(reader, url);
  await connected(reader);
  await expectText(reader, "");
});
