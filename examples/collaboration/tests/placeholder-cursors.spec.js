import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { api, register } from "./access-helpers.js";

for (const [path, name] of [
  ["/", "Shared document"],
  ["/multiplayer-form.html", "Project name"],
  ["/multiplayer-form.html", "What are we making?"],
  ["/multiplayer-form.html", "Who is it for?"],
]) test(`empty ${name} shows remote cursor at the start of its placeholder`, async ({ page, context, baseURL }) => {
  await register(page.request, baseURL);
  const room = `placeholder-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
  const url = `${baseURL}${path}?room=${room}`;
  await page.goto(url);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const peer = await context.newPage();
  await peer.goto(url);
  await expect(peer.locator("#save-status")).toHaveText("Saved");
  const source = page.getByRole("textbox", { name, exact: true });
  const target = peer.getByRole("textbox", { name, exact: true });
  await source.click();
  await expect(target.locator(".cm-placeholder")).toBeVisible();
  await expect(target.locator(".cm-ySelectionCaret")).toHaveCount(1);
  const offset = () => target.evaluate(node => {
    const caret = node.querySelector(".cm-ySelectionCaret").getBoundingClientRect();
    const placeholder = node.querySelector(".cm-placeholder").getBoundingClientRect();
    return { x: Math.abs(caret.left - placeholder.left), y: Math.abs(caret.top - placeholder.top) };
  });
  const before = await offset();
  console.log(`${name}: remote caret is ${before.x.toFixed(1)}px from the placeholder start`);
  await expect.poll(async () => (await offset()).x).toBeLessThan(3);
  // Wrapping and restoring a placeholder after deleting content must not
  // change its document position either.
  await peer.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await offset()).x).toBeLessThan(3);
  await source.fill("A short draft");
  await expect(target.locator(".cm-placeholder")).toHaveCount(0);
  await source.press("ControlOrMeta+a");
  await source.press("Backspace");
  await expect(target.locator(".cm-placeholder")).toBeVisible();
  await expect.poll(async () => (await offset()).x).toBeLessThan(3);
});

test("empty rich text keeps its remote caret at the paragraph start", async ({ page, context, baseURL }) => {
  await register(page.request, baseURL);
  const room = `rich-placeholder-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
  const url = `${baseURL}/rich-text.html?room=${room}`;
  await page.goto(url);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const source = page.getByRole("textbox", { name: "Rich text document", exact: true });
  await source.fill("Draft");
  const peer = await context.newPage();
  await peer.goto(url);
  await expect(peer.locator("#save-status")).toHaveText("Saved");
  await source.press("ControlOrMeta+a");
  await source.press("Backspace");
  const target = peer.getByRole("textbox", { name: "Rich text document", exact: true });
  await expect(target).toHaveAttribute("data-empty", "true");
  await expect(target.locator(".rich-caret")).toHaveCount(1);
  const offset = () => target.evaluate(node => Math.abs(
    node.querySelector(".rich-caret").getBoundingClientRect().left - node.querySelector("p").getBoundingClientRect().left));
  await expect.poll(offset).toBeLessThan(3);
  await peer.setViewportSize({ width: 390, height: 844 });
  await expect.poll(offset).toBeLessThan(3);
});
