import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Page } from "@playwright/test";

async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `board-${randomUUID()}`;
  const response = await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId });
  expect(response.ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/kanban.html?room=${roomId}` };
}
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
const card = (page: Page, title: string) => page.getByRole("button", { name: `Open card: ${title}`, exact: true });
async function addCard(page: Page, title: string) {
  await page.getByRole("button", { name: "Add card to Backlog", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(card(page, title)).toBeFocused();
  await saved(page);
}

test("cards sync, show presence, move by drag, and undo preserves a teammate's edit", async ({ page, context, baseURL }) => {
  const { url, user } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await addCard(page, "Release checklist");
  await card(peer, "Release checklist").click();
  await peer.getByLabel("Description").fill("Confirm the release with the team.");
  await peer.getByLabel("Color").selectOption("blue");
  await expect(page.locator(".card-presence")).toContainText(user.username);
  await peer.getByRole("button", { name: "Close card", exact: true }).click();
  const grip = await page.locator(".card-grip").boundingBox();
  if (!grip) throw new Error("Expected a visible element");
  const destination = await page.locator('[data-column="in-progress"] .column-heading').boundingBox();
  if (!destination) throw new Error("Expected a visible element");
  // The dedicated handle uses dnd-kit pointer sensors, including empty columns.
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 10, grip.y + grip.height / 2);
  await expect(page.locator('[data-dragging="true"]').first()).toBeVisible();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + 20, { steps: 12 });
  await expect(page.locator('[data-column="in-progress"]')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(peer.locator('[data-column="in-progress"]')).toContainText("Release checklist");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(peer.locator('[data-column="backlog"]')).toContainText("Release checklist");
  await expect(card(page, "Release checklist")).toContainText("Confirm the release with the team.");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(peer.locator('[data-column="in-progress"]')).toContainText("Release checklist");
  await card(page, "Release checklist").click();
  await page.getByRole("button", { name: "Delete card", exact: true }).click();
  await expect(peer.locator(".kanban-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(card(peer, "Release checklist")).toBeVisible();
});

test("offline changes converge and saved cards recover after a server crash", async ({ page, context, baseURL, backend }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await addCard(page, "Review onboarding");
  await expect(card(peer, "Review onboarding")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await card(page, "Review onboarding").click();
  await page.getByLabel("Status", { exact: true }).selectOption("done");
  await page.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await card(peer, "Review onboarding").click();
  await peer.getByLabel("Description").fill("Teammate edited while you were offline.");
  await peer.getByRole("button", { name: "Close card", exact: true }).click();
  await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await saved(page);
  await expect(peer.locator('[data-column="done"]')).toContainText("Review onboarding");
  await expect(card(page, "Review onboarding")).toContainText("Teammate edited while you were offline.");
  await page.close();
  await peer.close();
  await backend.restart();
  const fresh = await context.newPage();
  await fresh.goto(url);
  await saved(fresh);
  await expect(fresh.locator('[data-column="done"]')).toContainText("Review onboarding");
  await expect(card(fresh, "Review onboarding")).toContainText("Teammate edited while you were offline.");
});

test("viewers can inspect cards but cannot edit, and revocation freezes an open editor", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addCard(page, "Read-only review");
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const setRole = async (role: string) => expect((await api(page.request, baseURL,
      `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role })).ok()).toBe(true);
    await setRole("viewer");
    await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(viewer.getByRole("button", { name: "Add card to Backlog", exact: true })).toBeDisabled();
    await card(viewer, "Read-only review").click();
    await expect(viewer.getByLabel("Title", { exact: true })).not.toBeEditable();
    await expect(viewer.getByLabel("Description")).not.toBeEditable();
    await expect(viewer.getByLabel("Status", { exact: true })).toBeDisabled();
    await expect(viewer.getByRole("button", { name: "Delete card", exact: true })).toBeDisabled();
    await setRole("editor");
    await viewer.reload();
    await saved(viewer);
    await card(viewer, "Read-only review").click();
    await expect(viewer.getByLabel("Title", { exact: true })).toBeEditable();
    await setRole("viewer");
    await expect(viewer.getByLabel("Title", { exact: true })).not.toBeEditable();
    await setRole("editor");
    await viewer.reload();
    await saved(viewer);
    await viewer.getByRole("button", { name: "Move card: Read-only review", exact: true }).focus();
    await viewer.keyboard.press("Space");
    await expect(viewer.locator('[data-dragging="true"]').first()).toBeVisible();
    await setRole("viewer");
    await expect(viewer.locator('[data-dragging="true"]')).toHaveCount(0);
    await expect(viewer.locator('[data-column="backlog"]')).toContainText("Read-only review");
    await expect(viewer.locator(".card-grip")).toBeDisabled();
  } finally { await viewerContext.close(); }
});

test("board navigation stays on Kanban and the layout fits mobile", async ({ page, baseURL }, testInfo) => {
  await register(page.request, baseURL);
  await page.goto(`${baseURL}/kanban.html`);
  const roomId = `navigation-${randomUUID()}`;
  await page.getByRole("button", { name: "Create a room", exact: true }).click();
  await page.getByLabel("New room ID").fill(roomId);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/kanban.html?room=${roomId}`);
  await saved(page);
  await addCard(page, "Mobile planning");
  await page.screenshot({ path: testInfo.outputPath("kanban-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await card(page, "Mobile planning").click();
  await page.getByLabel("Status", { exact: true }).selectOption("done");
  await page.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(page.locator('[data-column="done"]')).toContainText("Mobile planning");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("kanban-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Select example", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Text editor", exact: true })).toHaveJSProperty("href", `${baseURL}/?room=${roomId}`);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Room details: ${roomId}` }).click();
  await page.getByRole("link", { name: "All rooms" }).click();
  await expect(page).toHaveURL(`${baseURL}/kanban.html`);
  await page.getByRole("link", { name: `${roomId} · owner`, exact: true }).click();
  await saved(page);
  await expect(card(page, "Mobile planning")).toBeVisible();
});


test("keyboard sorting preserves peer edits during a drag and Escape cancels a move", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addCard(page, "First task");
  await addCard(page, "Second task");
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  const grip = page.getByRole("button", { name: "Move card: Second task", exact: true });
  await grip.focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-dragging="true"]').first()).toBeVisible();
  await card(peer, "Second task").click();
  await peer.getByLabel("Description").fill("Updated while the card is moving.");
  await peer.getByRole("button", { name: "Close card", exact: true }).click();
  await saved(peer);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  const order = (target: Page) => target.locator('[data-column="backlog"] .card-title');
  await expect(order(peer)).toHaveText(["Second task", "First task"]);
  await expect(card(page, "Second task")).toContainText("Updated while the card is moving.");
  await grip.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(order(page)).toHaveText(["Second task", "First task"]);
  await expect(order(peer)).toHaveText(["Second task", "First task"]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(order(peer)).toHaveText(["First task", "Second task"]);
  await expect(card(page, "Second task")).toContainText("Updated while the card is moving.");
});

test("touch handles move cards to an empty column", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url);
  await saved(page);
  await addCard(page, "Touch planning");
  const grip = await page.getByRole("button", { name: "Move card: Touch planning", exact: true }).boundingBox();
  const target = await page.locator('[data-column="in-progress"] .column-heading').boundingBox();
  if (!grip || !target) throw new Error("Expected a visible touch handle and drop column");
  const session = await context.newCDPSession(page);
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  // The touch sensor waits briefly before lifting a card so ordinary scrolling
  // elsewhere in the board stays available.
  await expect(page.locator('[data-dragging="true"]').first()).toBeVisible();
  for (let step = 1; step <= 12; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: from.x + (to.x - from.x) * step / 12,
      y: from.y + (to.y - from.y) * step / 12,
    }] });
  }
  await expect(page.locator('[data-column="in-progress"]')).toHaveClass(/drop-target/);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator('[data-column="in-progress"]')).toContainText("Touch planning");
  await saved(page);
  await session.detach();
});
