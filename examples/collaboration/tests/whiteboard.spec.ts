import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Locator, Page } from "@playwright/test";

async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `whiteboard-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/whiteboard.html?room=${roomId}` };
}
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
const note = (page: Page, text: string) => page.getByRole("button", { name: `Sticky note: ${text}`, exact: true });
const position = (locator: Locator) => locator.evaluate((node: Element) => {
  const transform = new DOMMatrixReadOnly(getComputedStyle(node).transform);
  return { x: transform.m41, y: transform.m42 };
});
async function addNote(page: Page, text: string) {
  await page.getByRole("button", { name: "+ Sticky note", exact: true }).click();
  await page.getByLabel("Object text").fill(text);
  await saved(page);
}

test("whiteboard syncs objects, live drag previews, cursors, selections, and local undo", async ({ page, context, baseURL }) => {
  const { user, url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await addNote(page, "Launch ideas");
  await expect(note(peer, "Launch ideas")).toBeVisible();
  await note(peer, "Launch ideas").click();
  await peer.getByLabel("Object color").selectOption("mint");
  await expect(note(page, "Launch ideas")).toHaveClass(/color-mint/);
  await expect(page.locator(".remote-selection")).toContainText(user.username);
  await note(page, "Launch ideas").scrollIntoViewIfNeeded();
  const before = await position(note(page, "Launch ideas"));
  const box = await note(page, "Launch ideas").boundingBox();
  if (!box) throw new Error("Expected a visible element");
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 100, { steps: 8 });
  await expect.poll(() => position(note(peer, "Launch ideas"))).toEqual({ x: before.x + 90, y: before.y + 50 });
  await expect(peer.locator(".remote-cursor")).toContainText(user.username);
  await page.mouse.up();
  await saved(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => position(note(peer, "Launch ideas"))).toEqual(before);
  await expect(note(page, "Launch ideas")).toHaveClass(/color-mint/);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(() => position(note(peer, "Launch ideas"))).toEqual({ x: before.x + 90, y: before.y + 50 });
});

test("whiteboard cancels a drag, supports keyboard movement at zoom, resizing and deletion", async ({ page, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addNote(page, "Keep this idea");
  await page.getByLabel("Zoom out", { exact: true }).click();
  await note(page, "Keep this idea").scrollIntoViewIfNeeded();
  const before = await position(note(page, "Keep this idea"));
  const box = await note(page, "Keep this idea").boundingBox();
  if (!box) throw new Error("Expected a visible element");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => position(note(page, "Keep this idea"))).toEqual(before);
  await note(page, "Keep this idea").click();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => position(note(page, "Keep this idea"))).toEqual({ x: before.x + 10, y: before.y });
  await page.getByLabel("Width", { exact: true }).fill("300");
  await page.getByLabel("Width", { exact: true }).press("Tab");
  await expect(note(page, "Keep this idea")).toHaveCSS("width", "300px");
  await page.getByRole("button", { name: "Delete object", exact: true }).click();
  await expect(page.locator(".whiteboard-object")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(note(page, "Keep this idea")).toBeVisible();
});

test("whiteboard merges offline edits and restores saved shapes after a crash", async ({ page, context, baseURL, backend }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addNote(page, "Offline idea");
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await note(page, "Offline idea").click();
  const beforeMove = await position(note(page, "Offline idea"));
  await page.keyboard.press("Shift+ArrowRight");
  const moved = { x: beforeMove.x + 10, y: beforeMove.y };
  await expect.poll(() => position(note(page, "Offline idea"))).toEqual(moved);
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await note(peer, "Offline idea").click();
  await peer.getByLabel("Object text").fill("A teammate's contribution");
  await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await saved(page);
  await expect.poll(() => position(note(page, "A teammate's contribution"))).toEqual(moved);
  await page.close();
  await peer.close();
  await backend.restart();
  const fresh = await context.newPage();
  await fresh.goto(url);
  await saved(fresh);
  await expect.poll(() => position(note(fresh, "A teammate's contribution"))).toEqual(moved);
});

test("whiteboard viewers cannot mutate objects; revocation and mobile navigation work", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addNote(page, "Shared review");
  await page.getByRole("button", { name: "□ Rectangle", exact: true }).click();
  await page.getByLabel("Object text").fill("Plan");
  await page.getByRole("button", { name: "○ Ellipse", exact: true }).click();
  await page.getByLabel("Object text").fill("Outcome");
  await saved(page);
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer");
    await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(viewer.getByRole("button", { name: "+ Sticky note", exact: true })).toBeDisabled();
    // Move overlapping shapes out of the way for the review, using their owner.
    await page.getByRole("button", { name: "Delete object", exact: true }).click();
    await page.getByRole("button", { name: "Rectangle: Plan", exact: true }).click();
    await page.getByRole("button", { name: "Delete object", exact: true }).click();
    await note(viewer, "Shared review").click();
    await expect(viewer.getByLabel("Object text")).not.toBeEditable();
    await expect(viewer.getByLabel("Object color")).toBeDisabled();
    const before = await position(note(viewer, "Shared review"));
    await viewer.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => position(note(viewer, "Shared review"))).toEqual(before);
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await role("editor");
    await viewer.reload();
    await saved(viewer);
    await note(viewer, "Shared review").click();
    await expect(viewer.getByLabel("Object text")).toBeEditable();
    await role("viewer");
    await expect(viewer.getByLabel("Object text")).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Delete object", exact: true })).toBeDisabled();
  } finally { await viewerContext.close(); }
  await expect(page.getByRole("link", { name: "Try the Kanban board", exact: true })).toHaveJSProperty("href", `${baseURL}/kanban.html?room=${roomId}`);
});
