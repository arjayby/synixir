import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { canvas, drawShape, elementPoint, savedWhiteboard as saved, scene, selectShape, setupWhiteboard as setup } from "./whiteboard-helpers.ts";

test.setTimeout(90_000);

test("Excalidraw syncs shapes, live dragging, presence, and local undo", async ({ page, context, baseURL }) => {
  const { user, url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  const element = await drawShape(page);
  await expect.poll(async () => (await scene(peer)).length).toBe(1);
  await selectShape(peer, element.id);
  await peer.getByTestId("strokeWidth-bold").locator("..").click();
  await expect.poll(async () => (await scene(page))[0].strokeWidth).toBe(2);
  await expect.poll(() => page.evaluate(() => [...window.synixirWhiteboardTest!.getAppState().collaborators.values()]
    .map(peer => peer.username))).toContain(user.username);
  await selectShape(page, element.id);
  const point = await elementPoint(page, element.id);
  await page.mouse.move(point.x - element.width / 2, point.y); await page.mouse.down();
  await page.mouse.move(point.x - element.width / 2 + 90, point.y + 50, { steps: 8 });
  await expect.poll(async () => (await scene(peer))[0].x).toBeCloseTo(element.x + 90, 0);
  await page.mouse.up(); await saved(page);
  await page.locator("#undo").click();
  await expect.poll(async () => (await scene(peer))[0].x).toBeCloseTo(element.x, 0);
  expect((await scene(page))[0].strokeWidth).toBe(2);
  await page.locator("#redo").click();
  await expect.poll(async () => (await scene(peer))[0].x).toBeCloseTo(element.x + 90, 0);
  await page.screenshot({ path: "/tmp/synixir-whiteboard-desktop.png", fullPage: true });
});

test("Excalidraw supports native text, zoom, keyboard movement, resizing, and deletion", async ({ page, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  const element = await drawShape(page);
  await page.getByTestId("toolbar-text").locator("..").click();
  const box = await canvas(page).boundingBox();
  await page.mouse.click(box!.x + 280, box!.y + 350);
  await page.keyboard.type("Keep this idea");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await scene(page)).find(e => e.type === "text")?.text).toBe("Keep this idea");
  await selectShape(page, element.id);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await scene(page)).find(e => e.id === element.id)?.x).toBe(element.x + 5);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.synixirWhiteboardTest!.getAppState().zoom.value)).toBeLessThan(1);
  await selectShape(page, element.id);
  const state = await page.evaluate(id => {
    const api = window.synixirWhiteboardTest!, e = api.getSceneElements().find(e => e.id === id)!, s = api.getAppState();
    return { x: (e.x + e.width + s.scrollX) * s.zoom.value + s.offsetLeft,
      y: (e.y + e.height + s.scrollY) * s.zoom.value + s.offsetTop, width: e.width };
  }, element.id);
  await page.mouse.move(state.x + 4, state.y + 4); await page.mouse.down();
  await page.mouse.move(state.x + 50, state.y + 35, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await scene(page)).find(e => e.id === element.id)?.width ?? 0).toBeGreaterThan(state.width);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await scene(page)).some(e => e.id === element.id)).toBe(false);
  await page.locator("#undo").click();
  await expect.poll(async () => (await scene(page)).some(e => e.id === element.id)).toBe(true);
});

test("Excalidraw merges offline edits and restores saved scenes after a backend crash", async ({ page, context, baseURL, backend }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  const element = await drawShape(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await selectShape(page, element.id); await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await selectShape(peer, element.id); await peer.getByTestId("strokeWidth-bold").locator("..").click(); await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await saved(page);
  await expect.poll(async () => ({ x: (await scene(page))[0].x, stroke: (await scene(page))[0].strokeWidth }))
    .toEqual({ x: element.x + 5, stroke: 2 });
  await page.close(); await peer.close(); await backend.restart();
  const fresh = await context.newPage(); await fresh.goto(url); await saved(fresh);
  await expect.poll(async () => ({ x: (await scene(fresh))[0]?.x, stroke: (await scene(fresh))[0]?.strokeWidth }))
    .toEqual({ x: element.x + 5, stroke: 2 });
});

test("Excalidraw respects viewers, live revocation, mobile layout, and asset restrictions", async ({ page, browser, baseURL }) => {
  const { roomId, url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  const element = await drawShape(page);
  expect(await page.getByTestId("toolbar-image").count()).toBe(0);
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await viewerContext.newPage();
    const user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer"); await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect.poll(() => viewer.evaluate(() => window.synixirWhiteboardTest?.getAppState().viewModeEnabled)).toBe(true);
    expect(await viewer.getByTestId("toolbar-rectangle").count()).toBe(0);
    await canvas(viewer).click(); await viewer.keyboard.press("ControlOrMeta+a"); await viewer.keyboard.press("Delete");
    expect((await scene(viewer)).length).toBe(1);
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await role("editor"); await viewer.reload(); await saved(viewer);
    await expect(viewer.getByTestId("toolbar-rectangle")).toBeVisible();
    await viewer.screenshot({ path: "/tmp/synixir-whiteboard-mobile.png", fullPage: true });
    await selectShape(viewer, element.id);
    const point = await elementPoint(viewer, element.id);
    const zoom = await viewer.evaluate(() => window.synixirWhiteboardTest!.getAppState().zoom.value);
    await viewer.mouse.move(point.x - element.width * zoom / 2, point.y);
    await viewer.mouse.down();
    await role("viewer");
    await expect.poll(() => viewer.evaluate(() => window.synixirWhiteboardTest?.getAppState().viewModeEnabled)).toBe(true);
    const frozen = await scene(viewer);
    await viewer.mouse.move(point.x + 30, point.y + 30, { steps: 3 });
    await viewer.mouse.up();
    await expect.poll(async () => (await scene(viewer)).map(e => ({ id: e.id, x: e.x, y: e.y })))
      .toEqual(frozen.map(e => ({ id: e.id, x: e.x, y: e.y })));
    await expect(viewer.locator("#undo")).toBeDisabled();
    expect((await scene(viewer))[0].id).toBe(element.id);
  } finally { await viewerContext.close(); }
});
