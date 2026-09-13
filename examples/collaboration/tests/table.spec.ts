import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Page } from "@playwright/test";

async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `table-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/table.html?room=${roomId}` };
}
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
const cell = (page: Page, address: string) => page.getByRole("gridcell", { name: new RegExp(`^${address}:`) });
const display = (page: Page, address: string) => cell(page, address).locator(".cell-display");
async function edit(page: Page, address: string, value: string) {
  await cell(page, address).dblclick();
  await page.getByRole("textbox", { name: `Edit ${address}`, exact: true }).fill(value);
  await page.keyboard.press("Escape"); await saved(page);
}
async function paste(page: Page, address: string, value: string) {
  await cell(page, address).click();
  await cell(page, address).evaluate((node: { dispatchEvent: (arg0: ClipboardEvent) => void; }, value: string) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, value);
}

test("table shares same-cell typing, remote carets and selections while preserving the focused editor", async ({ page, context, baseURL }) => {
  const { user, url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await cell(page, "A1").dblclick();
  await page.getByRole("textbox", { name: "Edit A1", exact: true }).fill("Plan "); await saved(page);
  await expect(display(peer, "A1")).toHaveText("Plan ");
  await expect(cell(peer, "A1").locator(".cell-people")).toContainText(user.username);
  // A collaborator's caret is visible before this peer opens a local editor.
  await expect(cell(peer, "A1").locator(".cm-ySelectionCaret")).toHaveCount(1);
  await expect(cell(peer, "A1").locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await cell(peer, "A1").dblclick();
  await expect(cell(peer, "A1").locator(".cm-ySelectionCaret")).toHaveCount(1);
  await peer.evaluate(() => { window.originalCellEditor = document.querySelector<HTMLElement>('.cm-content')!; });
  await page.getByRole("textbox", { name: "Edit A1", exact: true }).press("End");
  await page.keyboard.insertText("the launch"); await saved(page);
  await expect(display(peer, "A1")).toHaveText("Plan the launch");
  expect(await peer.evaluate(() => window.originalCellEditor === document.querySelector<HTMLElement>('.cm-content')!)).toBe(true);
  await peer.keyboard.press("Escape");
  await edit(peer, "B1", "Mina");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(display(page, "B1")).toHaveText("Mina");
  await expect(display(page, "A1")).not.toHaveText("Plan the launch");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(display(page, "A1")).toHaveText("Plan the launch");
  await peer.close();
  await expect(page.locator(".cell-people:not([hidden])")).toHaveCount(0);
});

test("table navigates, pastes across cells, renames columns, and restores deleted rows", async ({ page, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await cell(page, "A1").focus(); await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Edit A1", exact: true }).fill("Draft");
  await page.keyboard.press("Tab"); await expect(cell(page, "B1")).toBeFocused();
  await page.keyboard.type("Sam"); await expect(page.getByRole("textbox", { name: "Edit B1", exact: true })).toHaveText("Sam");
  await page.keyboard.press("Enter"); await expect(cell(page, "B2")).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await expect(cell(page, "A2")).toBeFocused();
  await page.getByLabel("Column name", { exact: true }).fill("Deliverable"); await saved(page);
  await expect(page.getByRole("columnheader", { name: "A · Deliverable", exact: true })).toBeVisible();
  await paste(page, "D3", "One\tTwo\nThree\tFour"); await saved(page);
  await expect(page.locator("#table-count")).toHaveText("4 rows · 5 columns");
  await expect(display(page, "E4")).toHaveText("Four");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#table-count")).toHaveText("3 rows · 4 columns");
  await expect(display(page, "D3")).toHaveText("");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(display(page, "E4")).toHaveText("Four");
  await cell(page, "A1").click(); await page.getByRole("button", { name: "Delete row", exact: true }).click();
  await expect(page.locator("#table-count")).toHaveText("3 rows · 5 columns");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(display(page, "A1")).toHaveText("Draft");
  await expect(display(page, "B1")).toHaveText("Sam");
  await cell(page, "A1").click(); await page.getByRole("button", { name: "Delete column", exact: true }).click();
  await expect(display(page, "A1")).toHaveText("Sam");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(display(page, "A1")).toHaveText("Draft");
});

test("table merges disconnected edits to one cell and restores data and schema after restart", async ({ page, context, baseURL, backend }) => {
  const { url, roomId } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await edit(page, "A1", "Plan: ");
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await cell(page, "A1").dblclick(); await page.getByRole("textbox", { name: "Edit A1", exact: true }).press("End"); await page.keyboard.insertText("design ");
  await cell(peer, "A1").dblclick(); await peer.getByRole("textbox", { name: "Edit A1", exact: true }).press("End"); await peer.keyboard.insertText("build "); await peer.keyboard.press("Escape");
  await peer.getByRole("button", { name: "+ Add column", exact: true }).click();
  await peer.getByLabel("Column name", { exact: true }).fill("Notes"); await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await saved(page);
  await expect(display(page, "A1")).toContainText("design"); await expect(display(page, "A1")).toContainText("build");
  const merged = (await display(page, "A1").textContent())!;
  await expect(display(peer, "A1")).toHaveText(merged);
  await page.close(); await peer.close(); await backend.restart();
  const fresh = await context.newPage(); await fresh.goto(url); await saved(fresh);
  await expect(display(fresh, "A1")).toHaveText(merged);
  await expect(fresh.getByRole("columnheader", { name: "E · Notes", exact: true })).toBeVisible();
  await fresh.getByRole("button", { name: "Select example", exact: true }).click();
  await fresh.getByRole("menuitem", { name: "Project brief", exact: true }).click();
  await expect(fresh).toHaveURL(`${baseURL}/multiplayer-form.html?room=${roomId}`); await saved(fresh);
  await expect(fresh.getByRole("textbox", { name: "Project name", exact: true }).locator(".cm-placeholder")).toBeVisible();
});

test("table viewers cannot type, paste, delete or undo; live downgrades, revocation and mobile work", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL); await page.goto(url); await saved(page); await edit(page, "A1", "Keep this");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await context.newPage(), user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer"); await viewer.goto(url); await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(viewer.locator("#add-row")).toBeDisabled();
    await cell(viewer, "A1").click(); await viewer.keyboard.press("Delete"); await paste(viewer, "A1", "Replace");
    await expect(display(viewer, "A1")).toHaveText("Keep this");
    await expect(viewer.getByLabel("Column name", { exact: true })).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Delete column", exact: true })).toBeDisabled();
    await cell(viewer, "A1").dblclick(); await viewer.keyboard.type("Blocked");
    await expect(cell(page, "A1").locator(".cm-ySelectionCaret")).toHaveCount(1);
    await viewer.getByRole("textbox", { name: "Edit A1", exact: true }).evaluate(node => node.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })));
    await expect(display(viewer, "A1")).toHaveText("Keep this");
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await role("editor"); await viewer.reload(); await saved(viewer);
    await cell(viewer, "A1").dblclick(); await viewer.getByRole("textbox", { name: "Edit A1", exact: true }).fill("Allowed"); await saved(viewer);
    await role("viewer"); await expect(viewer.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await viewer.keyboard.type("Blocked"); await viewer.keyboard.press("ControlOrMeta+z");
    await expect(display(viewer, "A1")).toHaveText("Allowed");
    await expect(viewer.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await role("editor"); await viewer.reload(); await saved(viewer);
    await cell(viewer, "A1").dblclick();
    await viewer.getByRole("textbox", { name: "Edit A1", exact: true }).fill("Before revocation"); await saved(viewer);
    expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "DELETE")).ok()).toBe(true);
    await expect(viewer.locator("#add-row")).toBeDisabled();
    await viewer.keyboard.type("Blocked"); await viewer.keyboard.press("ControlOrMeta+z");
    await expect(display(viewer, "A1")).toHaveText("Before revocation");
    await expect(display(page, "A1")).toHaveText("Before revocation");
  } finally { await context.close(); }
});

test("table handles deletion of an actively edited cell and multi-cell paste while editing", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await edit(page, "A1", "Original");
  await cell(page, "A1").dblclick();
  await page.getByRole("textbox", { name: "Edit A1", exact: true }).evaluate(node => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "First\tSecond\nThird\tFourth");
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await saved(page); await expect(display(peer, "B2")).toHaveText("Fourth");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(display(page, "A1")).toHaveText("Original"); await expect(display(page, "B2")).toHaveText("");
  await cell(page, "A1").dblclick();
  await cell(peer, "A1").click(); await peer.getByRole("button", { name: "Delete row", exact: true }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await expect(page.locator("#cell-address")).toHaveText("Select a cell");
  await expect(page.locator("#table-count")).toHaveText("2 rows · 4 columns");
});

test("empty table carets align with the placeholder and stay scoped to their cell", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await cell(page, "A1").dblclick(); await cell(peer, "A1").dblclick();
  await expect(cell(peer, "A1").locator(".cm-ySelectionCaret")).toHaveCount(1);
  const gap = await cell(peer, "A1").evaluate((node) => Math.abs(node.querySelector('.cm-ySelectionCaret')!.getBoundingClientRect().x - node.querySelector('.cm-placeholder')!.getBoundingClientRect().x));
  expect(gap).toBeLessThan(3);
  await peer.keyboard.press("Escape"); await cell(peer, "B1").dblclick();
  await expect(cell(peer, "B1").locator(".cm-ySelectionCaret")).toHaveCount(0);
  await expect(cell(peer, "A1").locator(".cell-people")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(peer.locator(".cell-people:not([hidden])")).toHaveCount(0);
});


test("table resizes and virtualizes a populated grid without discarding an active cell", async ({ page, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  const values = Array.from({ length: 40 }, (_, index) => [
    `Launch task ${index + 1}`, ["Mina", "Sam", "Alex"][index % 3],
    index % 3 ? "In progress" : "Ready", `Sep ${14 + index % 15}`,
    "Product", "High", "Sprint 4", "Review with team",
  ].join("\t")).join("\n");
  await paste(page, "A1", values); await saved(page);
  const grid = page.getByRole("grid", { name: "Shared planning table" });
  await expect(grid).toHaveAttribute("aria-rowcount", "41");
  expect(await grid.getByRole("row").count()).toBeLessThan(41);
  const header = page.getByRole("columnheader", { name: "A · Task", exact: true });
  const bounds = (await header.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + 20);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width + 70, bounds.y + 20); await page.mouse.up();
  expect((await header.boundingBox())!.width).toBeGreaterThan(bounds.width + 50);
  await cell(page, "A1").dblclick();
  await page.evaluate(() => { window.originalCellEditor = document.querySelector<HTMLElement>(".rdg-editor-container .cm-content")!; });
  await grid.evaluate(node => { node.scrollTop = 2400; node.scrollLeft = 700; });
  await expect(cell(page, "H40")).toBeVisible();
  expect(await page.evaluate(() => window.originalCellEditor === document.querySelector(".rdg-editor-container .cm-content"))).toBe(true);
  await page.keyboard.press("Escape");
  await grid.evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
  await expect(cell(page, "A1")).toBeVisible();
  await page.screenshot({ path: "/tmp/synixir-table-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/synixir-table-mobile.png", fullPage: true });
});


test("table selection follows cell IDs when a peer deletes an earlier row or column", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await edit(page, "B2", "Stable cell");
  const original = await cell(page, "B2").getAttribute("data-cell");
  await cell(page, "B2").dblclick();
  await cell(peer, "A1").click(); await peer.getByRole("button", { name: "Delete row", exact: true }).click();
  await expect(page.locator("#cell-address")).toHaveText("B1");
  await expect(cell(page, "B1")).toHaveAttribute("data-cell", original!);
  await cell(peer, "A1").click(); await peer.getByRole("button", { name: "Delete column", exact: true }).click();
  await expect(page.locator("#cell-address")).toHaveText("A1");
  await expect(cell(page, "A1")).toHaveAttribute("data-cell", original!);
  await page.getByRole("button", { name: "Clear cell", exact: true }).click();
  await expect(display(peer, "A1")).toHaveText("");
  await peer.close();
});
