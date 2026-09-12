import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { api, register } from "./access-helpers.ts";

export async function setupWhiteboard(page: Page, baseURL: string | undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `whiteboard-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/whiteboard.html?room=${roomId}` };
}
export const savedWhiteboard = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
export const scene = (page: Page) => page.evaluate(() => window.synixirWhiteboardTest!.getSceneElements());
export const canvas = (page: Page) => page.locator(".excalidraw__canvas.interactive");
export async function drawShape(page: Page, kind = "rectangle", offset = 0) {
  await canvas(page).scrollIntoViewIfNeeded();
  await page.getByTestId(`toolbar-${kind}`).locator("..").click();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Missing drawing canvas");
  await expect.poll(() => page.evaluate(() => window.synixirWhiteboardTest!.getAppState().offsetTop)).toBeCloseTo(box.y, 0);
  await page.mouse.move(box.x + 280 + offset, box.y + 170);
  await page.mouse.down();
  await page.mouse.move(box.x + 430 + offset, box.y + 280, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await scene(page)).filter(e => e.type === kind).length).toBeGreaterThan(0);
  await savedWhiteboard(page);
  return (await scene(page)).filter(e => e.type === kind).at(-1)!;
}
export async function elementPoint(page: Page, id: string) {
  await canvas(page).scrollIntoViewIfNeeded();
  return page.evaluate(id => {
    const api = window.synixirWhiteboardTest!;
    const element = api.getSceneElements().find(e => e.id === id)!;
    const state = api.getAppState();
    return { x: (element.x + element.width / 2 + state.scrollX) * state.zoom.value + state.offsetLeft,
      y: (element.y + element.height / 2 + state.scrollY) * state.zoom.value + state.offsetTop };
  }, id);
}
export async function selectShape(page: Page, id: string) {
  await page.getByTestId("toolbar-selection").locator("..").click();
  const point = await elementPoint(page, id);
  // Outlined shapes are selected from their edge, regardless of fill.
  const state = await page.evaluate(id => {
    const api = window.synixirWhiteboardTest!;
    const element = api.getSceneElements().find(e => e.id === id)!;
    return { width: element.width, zoom: api.getAppState().zoom.value };
  }, id);
  await page.mouse.click(point.x - state.width * state.zoom / 2, point.y);
  await expect.poll(() => page.evaluate(id => Boolean(window.synixirWhiteboardTest!.getAppState().selectedElementIds[id]), id)).toBe(true);
}
