import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { changeConnection, openRoom } from "./access-helpers.ts";
import { connected, documentText, expectText, insertAtStart } from "./editor-helpers.ts";

test("dropdown shortcuts switch every example and preserve the current room", async ({ page, baseURL }, testInfo) => {
  const roomId = `shortcuts-${randomUUID()}`;
  await openRoom(page, `${baseURL}/?room=${roomId}`);
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const menu = page.getByRole("button", { name: "Select example", exact: true });
  await menu.click();
  const options = [
    ["Text editor", "e", "/"], ["Kanban board", "k", "/kanban"],
    ["Whiteboard", "w", "/whiteboard"], ["Rich text", "r", "/rich-text"],
    ["Form", "f", "/multiplayer-form"], ["Flowchart", "c", "/flowchart"],
    ["Table", "t", "/table"],
  ] as const;
  for (const [name, key] of options) {
    const item = page.getByRole("menuitem", { name, exact: true });
    await expect(item).toHaveAttribute("aria-keyshortcuts", key);
    await expect(item.locator('kbd[data-slot="kbd"]')).toHaveText(key.toUpperCase());
  }
  await page.screenshot({ path: testInfo.outputPath("shortcuts-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("menu")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("shortcuts-mobile.png") });

  // The first shortcut runs inside the menu; the rest run with the menu closed.
  for (const [name, key, path] of [...options.slice(1), options[0]]) {
    if (key !== "k") await menu.focus();
    await page.keyboard.press(key);
    await expect(page).toHaveURL(`${baseURL}${path}?room=${roomId}`);
    await connected(page);
    await expect(page.locator("#document-title")).toHaveText(name);
    await expect(page.locator("#save-status")).toHaveText("Saved");
  }
});

test("shortcuts respect editing, dialogs and the unsaved-draft warning", async ({ page, baseURL }) => {
  const roomId = `shortcut-draft-${randomUUID()}`;
  const url = `${baseURL}/?room=${roomId}`;
  await openRoom(page, url);
  await connected(page);
  await changeConnection(page, "Disconnect");
  await insertAtStart(page, "Keep this draft");

  // Shortcut letters must still type normally in the editor.
  await page.keyboard.press("k");
  await expect(page).toHaveURL(url);
  const draft = await documentText(page);
  expect(draft).toBe("Keep this draftk");

  await page.getByRole("button", { name: "Connection status", exact: true }).click();
  const alert = page.getByRole("alertdialog");
  await alert.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("k");
  await expect(alert).toBeVisible();
  await expect(page).toHaveURL(url);
  await alert.getByRole("button", { name: "Close", exact: true }).click();
  await expect(alert).toBeHidden();

  const menu = page.getByRole("button", { name: "Select example", exact: true });
  await menu.focus();
  // Selecting the current example must not reload and discard the draft.
  await page.keyboard.press("e");
  await expectText(page, draft);
  const prompt = page.waitForEvent("dialog");
  const shortcut = page.keyboard.press("k");
  const dialog = await prompt;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await shortcut;
  await expect(page).toHaveURL(url);
  await expectText(page, draft);
  await changeConnection(page, "Connect");
  await expect(page.locator("#save-status")).toHaveText("Saved");
});
