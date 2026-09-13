import { changeConnection, openRoom } from "./access-helpers.ts";
import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { connected, editor } from "./editor-helpers.ts";
import { Page } from "@playwright/test";

// CodeMirror virtualizes large documents. Read its public state instead of the
// visible DOM, and compare hashes so a failed assertion cannot dump megabytes.
async function expectDocument(page: Page, expected: string) {
  const digest = createHash("sha256").update(expected).digest("hex");
  await expect.poll(() => page.evaluate(async () => {
    const text = window.synixirTest.editor!.state.doc.toString();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  })).toBe(digest);
}

async function edit(page: Page, changes: { from: number; to?: number; insert?: string } | { from: number; to?: number; insert?: string }[]) {
  await page.evaluate(async (changes) => {
    window.synixirTest.editor!.dispatch({ changes });
  }, changes);
}

function binaryPush(message: string|number[]|Buffer<ArrayBufferLike>|[any,any,any,any,any]) {
  if (!Buffer.isBuffer(message) || message[0] !== 0) return null;
  const [, joinSize, refSize, topicSize, eventSize] = message;
  const eventStart = 5 + joinSize + refSize + topicSize;
  return {
    ref: message.subarray(5 + joinSize, 5 + joinSize + refSize).toString(),
    event: message.subarray(eventStart, eventStart + eventSize).toString(),
    payload: message.subarray(eventStart + eventSize),
  };
}

function chunk(push: { ref: string; event: string; payload: Buffer<ArrayBufferLike>; }|null) {
  if (push?.event !== "transfer_chunk") return null;
  const payload = push.payload;
  return { kind: payload[0], offset: payload.readUInt32BE(5), total: payload.readUInt32BE(9),
    final: payload.readUInt32BE(5) + payload.length - 13 === payload.readUInt32BE(9) };
}

const content = "x".repeat(1_100_000);

test("a document larger than one message survives offline edits, compaction and a server crash", async ({ page, context, baseURL, backend }) => {
  const room = `large-${randomUUID()}`;
  const url = `${baseURL}/?room=${room}`;
  let largestPayload = 0;
  page.on("websocket", ws => ws.on("framesent", ({ payload }) => {
    const push = binaryPush(payload);
    if (push) largestPayload = Math.max(largestPayload, push.payload.length);
  }));
  await openRoom(page, url);
  await connected(page);
  const peer = await context.newPage();
  await openRoom(peer, url);
  await connected(peer);
  await editor(page).click();
  await page.keyboard.insertText(content);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await expectDocument(peer, content);
  await changeConnection(page, "Disconnect");
  await edit(page, [{ from: 0, to: 1000 }, { from: content.length, insert: " offline👋" }]);
  await edit(peer, { from: 0, insert: "peer:" });
  await changeConnection(page, "Connect");
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const expected = `peer:${content.slice(1000)} offline👋`;
  await expectDocument(page, expected);
  await expectDocument(peer, expected);
  expect(largestPayload).toBeGreaterThan(0);
  expect(largestPayload).toBeLessThanOrEqual(1_048_576);
  backend.compact(room);
  await page.close();
  await peer.close();
  await backend.restart();
  const reader = await context.newPage();
  await openRoom(reader, url);
  await connected(reader);
  await expectDocument(reader, expected);
  await expect(reader.locator("#save-status")).toHaveText("Saved");
});

test("an interrupted chunk upload is never saved and reconnect retries the retained local edit", async ({ page, context, baseURL }) => {
  const url = `${baseURL}/?room=partial-${randomUUID()}`;
  let interrupt = true;
  await page.routeWebSocket("**/socket/websocket**", client => {
    const server = client.connectToServer();
    client.onMessage(message => {
      const part = chunk(binaryPush(message));
      if (interrupt && part && part.offset > 0) {
        client.close({ code: 1000, reason: "interrupt upload" });
        server.close();
        return;
      }
      server.send(message);
    });
  });
  await openRoom(page, url);
  await connected(page);
  await editor(page).click();
  await page.keyboard.insertText(content);
  await expect(page.locator("#status")).toHaveText("Reconnecting");
  await changeConnection(page, "Disconnect");
  await expect(page.locator("#save-status")).not.toHaveText("Saved");
  const reader = await context.newPage();
  await openRoom(reader, url);
  await connected(reader);
  await expectDocument(reader, "");
  interrupt = false;
  await changeConnection(page, "Connect");
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await expectDocument(reader, content);
});

test("a missing final chunk acknowledgement stays unconfirmed and stale replies cannot save a new generation", async ({ page, baseURL }) => {
  const url = `${baseURL}/?room=chunk-ack-${randomUUID()}`;
  let hold = true;
  const held: string[] = [];
  const release: (() => void)[] = [];
  await page.routeWebSocket("**/socket/websocket**", client => {
    const server = client.connectToServer();
    const refs = new Set();
    release.push(() => held.splice(0).forEach(message => client.send(message)));
    client.onMessage(message => {
      const push = binaryPush(message);
      const part = chunk(push);
      if (hold && part?.kind === 2 && part.final) refs.add(push!.ref);
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
  await openRoom(page, url);
  await connected(page);
  await editor(page).click();
  await page.keyboard.insertText(content);
  await expect(page.locator("#save-status")).toHaveText("Saving");
  await expect(page.locator("#save-status")).toHaveText("Save failed", { timeout: 15_000 });
  await changeConnection(page, "Disconnect");
  await edit(page, { from: content.length, insert: "new generation" });
  hold = false;
  // Deliver the old success while offline: it cannot confirm the new edit.
  for (const sendHeld of release) sendHeld();
  await expect(page.locator("#save-status")).not.toHaveText("Saved");
  await changeConnection(page, "Connect");
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.reload();
  await connected(page);
  await expectDocument(page, `${content}new generation`);
});
