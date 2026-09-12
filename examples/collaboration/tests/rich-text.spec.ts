import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Page } from "@playwright/test";

const document = (page: Page) => page.getByRole("textbox", { name: "Rich text document", exact: true });
const textWithoutCursors = (locator: { evaluate: (arg0: (node: any) => any) => any; }) => locator.evaluate((node: { cloneNode: (arg0: boolean) => any; }) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll(".rich-caret").forEach((caret: { remove: () => any; }) => caret.remove());
  return copy.textContent;
});
const content = (locator: any, text: unknown) => expect.poll(() => textWithoutCursors(locator)).toBe(text);
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `rich-text-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  const url = `${baseURL}/rich-text.html?room=${roomId}`;
  await page.goto(url);
  await saved(page);
  return { user, roomId, url };
}
async function selectAll(page: Page) {
  await document(page).click();
  await page.keyboard.press("ControlOrMeta+a");
}

test("rich text shares formatting, links, cursors and selections with local undo", async ({ page, context, baseURL }) => {
  const { url, user } = await setup(page, baseURL);
  await document(page).fill("A shared plan");
  await page.getByLabel("Text style", { exact: true }).selectOption("1");
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await content(document(peer).locator("h1"), "A shared plan");
  await selectAll(page);
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await content(document(peer).locator("strong"), "A shared plan");
  await expect(document(peer).locator(".rich-caret")).toContainText(user.username);
  await expect(document(peer).locator(".rich-selection")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Edit link", exact: true }).click();
  await page.getByLabel("Link URL", { exact: true }).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Apply link", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(document(peer).locator("a")).toHaveCount(0);
  await page.getByLabel("Link URL", { exact: true }).fill("https://example.com/plan");
  await page.getByRole("button", { name: "Apply link", exact: true }).click();
  await expect(document(peer).locator("a")).toHaveAttribute("href", "https://example.com/plan");
  await selectAll(peer);
  await peer.getByRole("button", { name: "Italic", exact: true }).click();
  await content(document(page).locator("em"), "A shared plan");
  await peer.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(document(page).locator("em")).toHaveCount(0);
  await content(document(page).locator("strong"), "A shared plan");
  await expect(document(page).locator("a")).toHaveAttribute("href", "https://example.com/plan");
  await peer.getByRole("button", { name: "Redo", exact: true }).click();
  await content(document(page).locator("em"), "A shared plan");
  await saved(peer);
});

test("rich text merges disconnected edits and restores formatted content after restart", async ({ page, context, baseURL, backend }) => {
  const { url } = await setup(page, baseURL);
  await document(page).fill("Shared sentence");
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await selectAll(page);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("Offline: ");
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await selectAll(peer);
  await peer.keyboard.press("ArrowRight");
  await peer.keyboard.insertText(" together.");
  await selectAll(peer);
  await peer.getByRole("button", { name: "Bold", exact: true }).click();
  await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await saved(page);
  await expect(document(page)).toContainText("Offline: Shared sentence together.");
  await expect(document(peer)).toContainText("Offline: Shared sentence together.");
  await expect(document(page).locator("strong")).toContainText("Shared sentence together.");
  await page.close();
  await peer.close();
  await backend.restart();
  const fresh = await context.newPage();
  await fresh.goto(url);
  await saved(fresh);
  await expect(document(fresh)).toHaveText("Offline: Shared sentence together.");
  await expect(document(fresh).locator("strong")).toContainText("Shared sentence together.");
});

test("rich text supports lists and quotes and keeps plain text content and cursors separate", async ({ page, context, baseURL }) => {
  const { roomId } = await setup(page, baseURL);
  await document(page).fill("First idea");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await document(page).press("End");
  await document(page).press("Enter");
  await page.keyboard.insertText("Second idea");
  await expect(document(page).locator("ul li")).toHaveCount(2);
  await page.getByRole("button", { name: "Numbered list", exact: true }).click();
  await expect(document(page).locator("ol li")).toHaveCount(2);
  await page.getByRole("button", { name: "Numbered list", exact: true }).click();
  await page.getByRole("button", { name: "Quote", exact: true }).click();
  await expect(document(page).locator("blockquote")).toContainText("Second idea");
  await saved(page);
  const plain = await context.newPage();
  await plain.goto(`${baseURL}/?room=${roomId}`);
  await saved(plain);
  await expect(plain.locator(".cm-placeholder")).toBeVisible();
  await plain.locator(".cm-content").fill("A separate plain document");
  await saved(plain);
  await expect(document(page)).not.toContainText("A separate plain document");
  await expect(document(page).locator(".rich-caret")).toHaveCount(0);
  await document(page).click();
  await expect(plain.locator(".cm-ySelectionInfo")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Try the text editor", exact: true })).toHaveJSProperty("href", `${baseURL}/?room=${roomId}`);
});

test("rich text viewer and revoked editor cannot edit, format, or undo; mobile fits", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL);
  await document(page).fill("Review this draft");
  await saved(page);
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer");
    await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(document(viewer)).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
    await content(document(viewer), "Review this draft");
    expect(await viewer.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await role("editor");
    await viewer.reload();
    await saved(viewer);
    await document(viewer).fill("An editor's revision");
    await saved(viewer);
    await role("viewer");
    await expect(document(viewer)).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await selectAll(viewer);
    await viewer.keyboard.press("ControlOrMeta+b");
    await viewer.keyboard.press("ControlOrMeta+z");
    await viewer.keyboard.type("cannot write");
    await content(document(viewer), "An editor's revision");
    await expect(document(viewer).locator("strong")).toHaveCount(0);
    await content(document(page), "An editor's revision");
  } finally { await viewerContext.close(); }
});
