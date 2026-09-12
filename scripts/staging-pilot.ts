import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { BrowserContext, type Page, type BrowserContextOptions, chromium, expect } from "@playwright/test";

const [mode, baseURL, manifestPath] = process.argv.slice(2);
assert.equal(new URL(baseURL).hostname, "localhost", "pilot is restricted to local staging");
assert.equal(new URL(baseURL).protocol, "https:");
const browser = await chromium.launch({ headless: true });
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const failedRequests: { path: string; error?: string|undefined; status?: number; }[] = [];
const password = randomBytes(24).toString("hex");

type Storage = BrowserContextOptions["storageState"];
interface Manifest { roomId: string; content: string; title: string; accounts: Record<string, { username: string; password: string; id: string; storage: Storage }> }
async function context(storageState?: Storage) {
  const value = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, storageState });
  value.on("page", page => {
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => failedRequests.push({
      path: new URL(request.url()).pathname, error: request.failure()?.errorText,
    }));
    page.on("response", response => {
      if (response.status() >= 400) failedRequests.push({
        path: new URL(response.url()).pathname, status: response.status(),
      });
    });
  });
  contexts.push(value);
  return value;
}

async function api(ctx: BrowserContext, path: string, method = "GET", data?: Record<string, unknown>) {
  const session = await (await ctx.request.get("/api/session")).json();
  return ctx.request.fetch(path, { method, data, headers: { "x-csrf-token": session.csrf_token } });
}

async function account(role: string) {
  const ctx = await context();
  const username = `pilot_${role}_${randomBytes(5).toString("hex")}`;
  const response = await api(ctx, "/api/accounts", "POST", { username, password });
  assert.equal(response.status(), 200, await response.text());
  const { user } = await response.json();
  const cookie = (await ctx.cookies()).find(cookie => cookie.name === "_synixir_key");
  assert.ok(cookie);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Lax");
  return { ctx, user, username, password };
}

async function open(ctx: BrowserContext, roomId: string, role: string|RegExp|readonly (string|RegExp)[]) {
  const page = await ctx.newPage();
  const response = await page.goto(`/?room=${roomId}`);
  assert.ok(response);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["cache-control"], "no-store");
  try {
    await expect(page.locator("#status")).toHaveText("Connected", { timeout: 15000 });
  } catch (error) {
    console.error("Pilot connection diagnostics:", JSON.stringify({
      role, pageErrors, failedRequests: failedRequests.slice(-20),
      accountError: await page.locator("#account-error").textContent(),
    }));
    throw error;
  }
  await expect(page.locator("#role-label")).toHaveText(role);
  return page;
}

async function text(page: Page, expected: string) {
  await expect.poll(() => page.locator(".cm-line").evaluateAll((lines) => lines.map(line => {
    const copy = line.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-ySelectionCaret, .cm-placeholder").forEach(node => node.remove());
    return copy.textContent;
  }).join("\n")), { timeout: 15000 }).toBe(expected);
}

async function saved(page: Page) {
  await expect(page.locator("#save-status")).toHaveText("Saved", { timeout: 15000 });
}

async function rejectsOrigin(origin: string) {
  const url = new URL("/socket/websocket?vsn=2.0.0", baseURL);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { rejectUnauthorized: false, headers: {
      Origin: origin, Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    } });
    req.on("response", (response: { resume: () => void; statusCode: unknown; }) => { response.resume(); resolve(response.statusCode); });
    req.on("upgrade", (_response: any, socket: { destroy: () => void; }) => { socket.destroy(); reject(new Error("Untrusted origin upgraded")); });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Origin rejection timed out")));
    req.end();
  });
}

try {
  if (mode === "seed") {
    const owner = await account("owner"), editor = await account("editor"), viewer = await account("viewer");
    const roomId = `pilot_${randomBytes(8).toString("hex")}`;
    assert.equal((await api(owner.ctx, "/api/rooms", "POST", { room_id: roomId })).status(), 200);
    for (const [person, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
      assert.equal((await api(owner.ctx, `/api/rooms/${roomId}/members/${person.username}`, "PUT", { role })).status(), 200);
    }
    const first = await open(owner.ctx, roomId, "owner");
    const second = await open(editor.ctx, roomId, "editor");
    const third = await open(viewer.ctx, roomId, "viewer");
    await expect(third.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
    await third.getByRole("textbox", { name: "Shared document" }).click();
    await third.keyboard.insertText("viewer must not write");
    await text(third, "");
    await expect(third.locator("#save-status")).toHaveText("View only");
    const content = "Staging 🌍 collaboration";
    await first.getByRole("textbox", { name: "Shared document" }).click();
    await first.keyboard.insertText(content);
    await saved(first);
    for (const page of [second, third]) await text(page, content);

    await second.locator("#connection").click();
    await expect(second.locator("#status")).toHaveText("Disconnected");
    await second.getByRole("textbox", { name: "Shared document" }).click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.insertText(" offline");
    await text(first, content);
    await second.locator("#connection").click();
    await expect(second.locator("#status")).toHaveText("Connected");
    await saved(second);
    for (const page of [first, second, third]) await text(page, content + " offline");
    const denied = await api(viewer.ctx, `/api/rooms/${roomId}/members/${editor.username}`, "PUT", { role: "owner" });
    assert.equal(denied.status(), 403);

    const settings = await owner.ctx.newPage();
    await settings.goto(`/sdk.html?room=${roomId}`);
    await expect(settings.locator("#sdk-state")).toHaveText("connected · saved", { timeout: 15000 });
    await settings.locator("#sdk-title").fill("Packaged SDK settings");
    await expect(settings.locator("#sdk-state")).toHaveText("connected · saved");
    // Exercise every exported route and its lazy-loaded editor bundle in the release.
    for (const route of ["kanban", "whiteboard", "rich-text", "multiplayer-form", "flowchart", "table"]) {
      await settings.goto(`/${route}.html?room=${roomId}`);
      await expect(settings.locator("#status")).toHaveText("Connected", { timeout: 15000 });
      await expect(settings.locator("#editor")).toBeVisible();
    }
    assert.equal((await owner.ctx.request.get("/metrics")).status(), 404);
    const forwarded = await owner.ctx.request.get("/api/session", {
      headers: { "X-Forwarded-Proto": "http", "X-Forwarded-For": "203.0.113.44" }, maxRedirects: 0 });
    assert.equal(forwarded.status(), 200, "gateway must overwrite a forged scheme");
    assert.equal(await rejectsOrigin("https://untrusted.example"), 403);
    assert.equal(await rejectsOrigin("https://localhost"), 403, "origin port must match");

    const manifest: Manifest = { roomId, content: content + " offline", title: "Packaged SDK settings", accounts: {} };
    for (const [role, person] of [["owner", owner], ["editor", editor], ["viewer", viewer]] as const) {
      manifest.accounts[role] = { username: person.username, password: person.password,
        id: person.user.id, storage: await person.ctx.storageState() };
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

    // Vary forged addresses; nginx must keep all these attempts in the real client's bucket.
    let last;
    for (let n = 1; n <= 21; n++) {
      const session = await (await owner.ctx.request.get("/api/session")).json();
      last = await owner.ctx.request.post("/api/session", { data: { username: owner.username, password: "wrong" },
        headers: { "x-csrf-token": session.csrf_token, "x-forwarded-for": `203.0.113.${n}` } });
      assert.ok([401, 429].includes(last.status()));
    }
    assert.equal(last!.status(), 429, "forwarded address must not bypass throttling");
    console.log("Pilot passed: packaged pages, HTTPS cookies, collaboration, roles, offline edits, origin and proxy checks");
  } else if (mode === "verify") {
    const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const [role, person] of Object.entries(manifest.accounts)) {
      const ctx = await context(person.storage);
      const session = await (await ctx.request.get("/api/session")).json();
      assert.equal(session.user.id, person.id, "session must survive release replacement");
      const page = await open(ctx, manifest.roomId, role);
      await text(page, manifest.content);
      if (role !== "viewer") await saved(page);
    }
    const ctx = await context();
    const owner = manifest.accounts.owner;
    assert.equal((await api(ctx, "/api/session", "POST", { username: owner.username, password: owner.password })).status(), 200);
    const settings = await ctx.newPage();
    await settings.goto(`/sdk.html?room=${manifest.roomId}`);
    await expect(settings.locator("#sdk-state")).toHaveText("connected · saved", { timeout: 15000 });
    await expect(settings.locator("#sdk-title")).toHaveValue(manifest.title);
    console.log("Pilot passed after replacement: sessions, passwords, permissions, document and SDK state retained");
  } else {
    throw new Error("Expected seed or verify");
  }
  assert.deepEqual(pageErrors, [], "browser JavaScript errors");
} finally {
  await Promise.allSettled(contexts.map(ctx => ctx.close()));
  await browser.close();
}
