import { test, expect } from "./fixtures.ts";
import { canvas, drawShape, elementPoint, savedWhiteboard as saved, scene, selectShape, setupWhiteboard as setup } from "./whiteboard-helpers.ts";

test.setTimeout(90_000);
for (const reducedMotion of [false, true]) test(`Excalidraw cursor motion leaves shared scene and roster stable, reduced motion=${reducedMotion}`, async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url); await saved(page); await drawShape(page);
  const peer = await context.newPage();
  await peer.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await peer.goto(url); await saved(peer);
  await canvas(page).scrollIntoViewIfNeeded();
  const box = await canvas(page).boundingBox();
  await page.mouse.move(box!.x + 250, box!.y + 400);
  const remotePointer = () => peer.evaluate(() => [...window.synixirWhiteboardTest!.getAppState().collaborators.values()][0]?.pointer);
  await expect.poll(async () => (await remotePointer())?.x).toBeCloseTo(250, 0);
  const original = (await remotePointer())!;
  const docBefore = await peer.evaluate(() => JSON.stringify(window.synixirTest.room!.doc.toJSON()));
  const stable = peer.evaluate(async () => {
    const canvas = document.querySelector(".excalidraw__canvas.interactive");
    const roster = document.querySelector("#participants li:last-child");
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(document.querySelector("#participants")!, { childList: true, subtree: true, characterData: true, attributes: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    observer.disconnect();
    return { sameCanvas: canvas === document.querySelector(".excalidraw__canvas.interactive"),
      sameRoster: roster === document.querySelector("#participants li:last-child"), mutations };
  });
  await page.mouse.move(box!.x + 450, box!.y + 400, { steps: 8 });
  await expect.poll(async () => (await remotePointer())?.x).toBeCloseTo(original.x + 200, 0);
  expect(await stable).toEqual({ sameCanvas: true, sameRoster: true, mutations: 0 });
  expect(await peer.evaluate(() => JSON.stringify(window.synixirTest.room!.doc.toJSON()))).toBe(docBefore);
  await page.mouse.move(box!.x + 250, box!.y - 20);
  await expect.poll(remotePointer).toBeUndefined();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => peer.evaluate(() => window.synixirWhiteboardTest!.getAppState().collaborators.size)).toBe(0);
  await expect(peer.locator("#participants li")).toHaveCount(1);
});

test("Excalidraw shows a peer's active drag and selection before pointer release", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  const element = await drawShape(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await selectShape(page, element.id);
  const point = await elementPoint(page, element.id);
  await page.mouse.move(point.x - element.width / 2, point.y); await page.mouse.down();
  await page.mouse.move(point.x - element.width / 2 + 120, point.y, { steps: 8 });
  await expect.poll(async () => (await scene(page))[0].x).toBeCloseTo(element.x + 120, 0);
  await expect.poll(async () => (await scene(peer))[0].x).toBeCloseTo(element.x + 120, 0);
  await expect.poll(() => peer.evaluate(id => [...window.synixirWhiteboardTest!.getAppState().collaborators.values()]
    .some(peer => peer.selectedElementIds?.[id] && peer.button === "down"), element.id)).toBe(true);
  await page.mouse.up(); await saved(page);
  expect((await scene(peer))[0].x).toBe((await scene(page))[0].x);
});
