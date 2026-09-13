import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Locator, Page } from "@playwright/test";

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
const value = (locator: Locator) => locator.locator(".cm-line").evaluateAll((lines: any[]) => lines.map((line: { cloneNode: (arg0: boolean) => any; }) => {
  const copy = line.cloneNode(true);
  copy.querySelectorAll(".cm-ySelectionCaret, .cm-placeholder").forEach((node: { remove: () => any; }) => node.remove());
  return copy.textContent;
}).join("\n"));
const hasValue = (page: Page, name: string, text: unknown) => expect.poll(() => value(field(page, name))).toBe(text);
async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `form-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  const url = `${baseURL}/multiplayer-form?room=${roomId}`;
  await page.goto(url);
  await saved(page);
  return { user, roomId, url };
}
async function fillBrief(page: Page) {
  await field(page, "Project name").fill("A shared launch");
  await field(page, "What are we making?").fill("A clearer way to plan together.");
  await field(page, "Who is it for?").fill("Small product teams.");
  await page.getByRole("combobox", { name: "Team", exact: true }).selectOption("Product");
  await saved(page);
}

test("form shares fields, field presence and local undo without replacing focused controls", async ({ page, context, baseURL }) => {
  const { url, user } = await setup(page, baseURL);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await field(page, "Project name").fill("Shared brief");
  await hasValue(peer, "Project name", "Shared brief");
  await expect(peer.locator("#people-name")).toHaveText(`${user.username} editing`);
  await field(peer, "What are we making?").fill("A useful new feature");
  await hasValue(page, "What are we making?", "A useful new feature");
  await expect(page.locator("#people-goal")).toHaveText(`${user.username} editing`);
  await expect(field(peer, "What are we making?")).toBeFocused();
  await page.getByLabel("Priority", { exact: true }).selectOption("High");
  await expect(peer.getByLabel("Priority", { exact: true })).toHaveValue("High");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(peer.getByLabel("Priority", { exact: true })).toHaveValue("Normal");
  await hasValue(peer, "What are we making?", "A useful new feature");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(peer.getByLabel("Priority", { exact: true })).toHaveValue("High");
  await page.getByRole("checkbox", { name: "Website", exact: true }).check();
  await expect(peer.getByRole("checkbox", { name: "Website", exact: true })).toBeChecked();
  await expect(field(peer, "What are we making?")).toBeFocused();
  await peer.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#people-goal")).toHaveText("");
  await saved(page);
});

test("form validation stays local and remote corrections preserve the active editor", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  const name = field(page, "Project name");
  const original = await name.elementHandle();
  await name.fill("N".repeat(121));
  await hasValue(peer, "Project name", "N".repeat(121));
  await expect(page.locator("#error-name")).toHaveCount(0);
  await field(page, "What are we making?").click();
  await expect(page.locator("#error-name")).toHaveText("Use 120 characters or fewer.");
  await expect(peer.locator("#error-name")).toHaveCount(0);
  await field(peer, "Project name").fill("A corrected shared draft");
  await expect(page.locator("#error-name")).toHaveCount(0);
  await hasValue(page, "Project name", "A corrected shared draft");
  await expect(field(page, "What are we making?")).toBeFocused();
  expect(await name.evaluate((node, before) => node === before, original)).toBe(true);
  await saved(peer);
});

test("same-field offline edits and checkbox choices merge and persist after restart", async ({ page, context, baseURL, backend }) => {
  const { url } = await setup(page, baseURL);
  await field(page, "Project name").fill("Launch");
  await saved(page);
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await field(page, "Project name").press("ControlOrMeta+a");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("Our ");
  await page.getByRole("checkbox", { name: "Website", exact: true }).check();
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await field(peer, "Project name").press("ControlOrMeta+a");
  await peer.keyboard.press("ArrowRight");
  await peer.keyboard.insertText(" together");
  await peer.getByRole("checkbox", { name: "Email", exact: true }).check();
  await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await saved(page);
  await hasValue(page, "Project name", "Our Launch together");
  await hasValue(peer, "Project name", "Our Launch together");
  await expect(page.getByRole("checkbox", { name: "Email", exact: true })).toBeChecked();
  await expect(peer.getByRole("checkbox", { name: "Website", exact: true })).toBeChecked();
  await page.close();
  await peer.close();
  await backend.restart();
  const fresh = await context.newPage();
  await fresh.goto(url);
  await saved(fresh);
  await hasValue(fresh, "Project name", "Our Launch together");
  await expect(fresh.getByRole("checkbox", { name: "Email", exact: true })).toBeChecked();
  await expect(fresh.getByRole("checkbox", { name: "Website", exact: true })).toBeChecked();
});

test("form validates required fields, shows a live preview and keeps other example content separate", async ({ page, context, baseURL }, testInfo) => {
  const { roomId, url } = await setup(page, baseURL);
  await page.getByRole("button", { name: "Review brief", exact: true }).click();
  await expect(field(page, "Project name")).toHaveAttribute("aria-invalid", "true");
  await expect(field(page, "Project name")).toBeFocused();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await fillBrief(page);
  await expect(page.locator("#brief-completion")).toHaveText("4 of 4 complete");
  await expect(page.locator("#brief-announcement")).toHaveText("");
  await page.getByLabel("Target date", { exact: true }).fill("2027-06-15");
  await page.screenshot({ path: testInfo.outputPath("form-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Review brief", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("A shared launch");
  await expect(page.getByRole("dialog")).toContainText("2027-06-15");
  const peer = await context.newPage();
  await peer.goto(url);
  await saved(peer);
  await field(peer, "Project name").fill("A better shared launch");
  await expect(page.getByRole("dialog")).toContainText("A better shared launch");
  await saved(peer);
  const plain = await context.newPage();
  await plain.goto(`${baseURL}/?room=${roomId}`);
  await saved(plain);
  await expect(plain.locator(".cm-placeholder")).toBeVisible();
  await plain.getByRole("textbox", { name: "Shared document", exact: true }).fill("Separate text");
  await saved(plain);
  await expect(peer.locator(".cm-ySelectionInfo")).toHaveCount(0);
  await hasValue(peer, "Project name", "A better shared launch");
});

test("form viewers and revoked editors cannot mutate fields or use history; mobile fits", async ({ page, browser, baseURL }, testInfo) => {
  const { roomId, url } = await setup(page, baseURL);
  await fillBrief(page);
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer");
    await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(field(viewer, "Project name")).toHaveAttribute("aria-readonly", "true");
    await expect(viewer.getByRole("combobox", { name: "Team", exact: true })).toBeDisabled();
    await expect(viewer.getByRole("checkbox", { name: "Website", exact: true })).toBeDisabled();
    await field(viewer, "Who is it for?").click();
    await expect(page.locator("#people-audience")).toHaveText(`${user.username} viewing`);
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.screenshot({ path: testInfo.outputPath("form-mobile.png"), fullPage: true });
    await role("editor");
    await viewer.reload();
    await saved(viewer);
    await field(viewer, "Project name").fill("An editor's draft");
    await saved(viewer);
    await role("viewer");
    await expect(field(viewer, "Project name")).toHaveAttribute("aria-readonly", "true");
    await field(viewer, "Project name").press("ControlOrMeta+z");
    await viewer.keyboard.type("blocked");
    await hasValue(viewer, "Project name", "An editor's draft");
    await hasValue(page, "Project name", "An editor's draft");
    await expect(viewer.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  } finally { await viewerContext.close(); }
});
