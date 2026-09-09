import { expect } from "./fixtures.js";

export const editor = page => page.getByRole("textbox", { name: "Shared document" });

export async function documentText(page) {
  return editor(page).locator(".cm-line").evaluateAll(lines => lines.map(line => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll(".cm-ySelectionCaret, .cm-placeholder").forEach(node => node.remove());
    return copy.textContent;
  }).join("\n"));
}

export async function expectText(page, value) {
  if (value instanceof RegExp) await expect.poll(() => documentText(page)).toMatch(value);
  else await expect.poll(() => documentText(page)).toBe(value);
}

export async function insertAtStart(page, value) {
  await editor(page).click();
  await editor(page).press("ControlOrMeta+Home");
  await page.keyboard.insertText(value);
}

export async function connected(page) {
  await expect(page.locator("#status")).toHaveText("Connected");
}
