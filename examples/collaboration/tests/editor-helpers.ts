import { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export const editor = (page: Page) => page.getByRole("textbox", { name: "Shared document" });

export async function documentText(page: Page) {
  return editor(page).locator(".cm-line").evaluateAll((lines: any[]) => lines.map((line: { cloneNode: (arg0: boolean) => any; }) => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll(".cm-ySelectionCaret, .cm-placeholder").forEach((node: { remove: () => any; }) => node.remove());
    return copy.textContent;
  }).join("\n"));
}

export async function expectText(page: Page, value: unknown) {
  if (value instanceof RegExp) await expect.poll(() => documentText(page)).toMatch(value);
  else await expect.poll(() => documentText(page)).toBe(value);
}

export async function insertAtStart(page: Page, value: string) {
  await editor(page).click();
  await editor(page).press("ControlOrMeta+Home");
  await page.keyboard.insertText(value);
}

export async function connected(page: Page) {
  await expect(page.locator("#status")).toHaveText("Connected");
}
