import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { api, register, password } from "./access-helpers.js";
import { connected, editor, expectText, insertAtStart } from "./editor-helpers.js";

const username = prefix => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
async function signIn(page, name, button = "Sign in") {
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: button, exact: true }).click();
}

test("owners manage private rooms and viewers cannot edit", async ({ page, browser, baseURL }) => {
  await page.goto(baseURL);
  await signIn(page, username("owner"), "Create account");
  await expect(page.getByRole("heading", { name: "Your rooms", exact: true })).toBeVisible();
  const room = `private-${randomUUID()}`;
  await page.getByLabel("New room ID").fill(room);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await connected(page);
  await expect(page.locator("#role-label")).toHaveText("owner");
  await insertAtStart(page, "Owner's saved text");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const viewerContext = await browser.newContext();
  try {
    const viewer = await register(viewerContext.request, baseURL);
    const reader = await viewerContext.newPage();
    await reader.goto(`${baseURL}/?room=${room}`);
    await expect(reader.locator("#status")).toHaveText("Access expired or denied");
    await expectText(reader, "");
    await page.getByLabel("Account username", { exact: true }).fill(viewer.username);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Grant access", exact: true }).click();
    await expect(page.getByLabel(`Role for ${viewer.username}`)).toHaveValue("viewer");
    await reader.reload();
    await connected(reader);
    await expectText(reader, "Owner's saved text");
    await expect(reader.locator("#save-status")).toHaveText("View only");
    await expect(reader.locator("#members-panel")).toBeHidden();
    await editor(reader).click();
    await reader.keyboard.insertText("forbidden");
    await expectText(reader, "Owner's saved text");
    await page.getByLabel(`Role for ${viewer.username}`).selectOption("editor");
    await expect(reader.locator("#status")).toContainText("Access changed");
    await reader.getByRole("button", { name: "Reload", exact: true }).click();
    await connected(reader);
    await insertAtStart(reader, "Editor: ");
    await expect(reader.locator("#save-status")).toHaveText("Saved");
    await expectText(page, "Editor: Owner's saved text");
    await page.getByRole("button", { name: `Remove ${viewer.username}`, exact: true }).click();
    await expect(reader.locator("#status")).toContainText("Access changed");
    await insertAtStart(page, "Private again. ");
    await expect(page.locator("#save-status")).toHaveText("Saved");
    await expectText(reader, "Editor: Owner's saved text");
    await reader.reload();
    await expect(reader.locator("#status")).toHaveText("Access expired or denied");
    await expectText(reader, "");
  } finally { await viewerContext.close(); }
});

test("signing out clears every tab before a different account signs in", async ({ page, context, baseURL }) => {
  const owner = await register(context.request, baseURL);
  const room = `logout-${randomUUID()}`;
  expect((await api(context.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
  const url = `${baseURL}/?room=${room}`;
  await page.goto(url);
  await connected(page);
  await insertAtStart(page, "Private account document");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const second = await context.newPage();
  await second.goto(url);
  await connected(second);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  for (const tab of [page, second]) {
    await expect(tab.locator("#auth-panel")).toBeVisible();
    await expect(tab.locator("#editor")).toBeEmpty();
  }
  await signIn(page, username("other"), "Create account");
  await expect(page.locator("#status")).toHaveText("Access expired or denied");
  await expectText(page, "");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, owner.username);
  await connected(page);
  await expectText(page, "Private account document");
});

test("a role changed while disconnected preserves the draft until a fresh read-only join", async ({ page, context, browser, baseURL }) => {
  await register(context.request, baseURL);
  const room = `offline-role-${randomUUID()}`;
  expect((await api(context.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
  await page.goto(`${baseURL}/?room=${room}`);
  await connected(page);
  await insertAtStart(page, "Saved document");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const memberContext = await browser.newContext();
  try {
    const member = await register(memberContext.request, baseURL);
    const path = `/api/rooms/${room}/members/${member.username}`;
    expect((await api(context.request, baseURL, path, "PUT", { role: "editor" })).ok()).toBe(true);
    const client = await memberContext.newPage();
    await client.goto(`${baseURL}/?room=${room}`);
    await connected(client);
    await client.getByRole("button", { name: "Disconnect", exact: true }).click();
    await insertAtStart(client, "Offline draft: ");
    await expect(client.locator("#save-status")).toHaveText("Unsaved changes");
    expect((await api(context.request, baseURL, path, "PUT", { role: "viewer" })).ok()).toBe(true);
    await client.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(client.locator("#status")).toContainText("Access changed");
    await expectText(client, "Offline draft: Saved document");
    await editor(client).click();
    await client.keyboard.insertText("forbidden");
    await expectText(client, "Offline draft: Saved document");
    await client.keyboard.press("ControlOrMeta+z");
    await expectText(client, "Offline draft: Saved document");
    await client.keyboard.press("ControlOrMeta+Shift+Z");
    await expectText(client, "Offline draft: Saved document");
    client.once("dialog", dialog => dialog.accept());
    await client.getByRole("button", { name: "Reload", exact: true }).click();
    await connected(client);
    await expect(client.locator("#save-status")).toHaveText("View only");
    await expectText(client, "Saved document");
    await expectText(page, "Saved document");
  } finally { await memberContext.close(); }
});

test("reconnecting after a cookie account switch cannot upload the old account's draft", async ({ page, context, browser, baseURL }) => {
  await register(context.request, baseURL);
  const room = `account-switch-${randomUUID()}`;
  expect((await api(context.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
  await page.goto(`${baseURL}/?room=${room}`);
  await connected(page);
  await insertAtStart(page, "Shared saved document");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const memberContext = await browser.newContext();
  try {
    const first = await register(memberContext.request, baseURL);
    expect((await api(context.request, baseURL, `/api/rooms/${room}/members/${first.username}`, "PUT", { role: "editor" })).ok()).toBe(true);
    const client = await memberContext.newPage();
    await client.goto(`${baseURL}/?room=${room}`);
    await connected(client);
    await client.getByRole("button", { name: "Disconnect", exact: true }).click();
    await insertAtStart(client, "First account's private draft: ");
    // Switch cookies through the API, without this page receiving a storage event.
    const second = await register(memberContext.request, baseURL);
    expect((await api(context.request, baseURL, `/api/rooms/${room}/members/${second.username}`, "PUT", { role: "editor" })).ok()).toBe(true);
    await client.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(client.locator("#account-name")).toHaveText(second.username);
    await connected(client);
    await expectText(client, "Shared saved document");
    await expectText(page, "Shared saved document");
  } finally { await memberContext.close(); }
});
