import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { Locator, Page } from "@playwright/test";

async function setup(page: Page, baseURL: string|undefined) {
  const user = await register(page.request, baseURL);
  const roomId = `flowchart-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  return { user, roomId, url: `${baseURL}/flowchart.html?room=${roomId}` };
}
const saved = (page: Page) => expect(page.locator("#save-status")).toHaveText("Saved");
const node = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const position = (locator: Locator) => locator.evaluate((element: Element) => {
  const t = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: t.m41, y: t.m42 };
});
async function add(page: Page, kind: string, label: string) {
  await page.locator(`[data-add="${kind}"]`).click();
  await page.getByLabel("Node text", { exact: true }).fill(label);
  await saved(page);
}
async function connect(page: Page, from: string, to: string, label: string) {
  await node(page, from).click();
  await page.getByLabel("Connect to", { exact: true }).selectOption({ label: to });
  await page.getByLabel("Branch label", { exact: true }).fill(label);
  await page.getByRole("button", { name: "Connect nodes", exact: true }).click();
  await saved(page);
}

test("flowchart shares branches, smooth drags, cursors, selections, and local undo", async ({ page, context, baseURL }, testInfo) => {
  const { user, url } = await setup(page, baseURL);
  await page.goto(url); await saved(page);
  await add(page, "terminal", "Request");
  await add(page, "decision", "Approved?");
  await add(page, "process", "Publish");
  await connect(page, "Start / End: Request", "Approved?", "Review");
  await connect(page, "Decision: Approved?", "Publish", "Yes");
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await expect(peer.locator(".flow-edge")).toHaveCount(2);
  await expect(peer.getByRole("button", { name: "Approved? → Publish · Yes", exact: true })).toBeVisible();
  await node(peer, "Decision: Approved?").click();
  await peer.getByLabel("Node color").selectOption("rose");
  await expect(page.locator(".remote-selection")).toContainText(user.username);
  const item = node(page, "Decision: Approved?");
  await item.scrollIntoViewIfNeeded();
  const before = await position(item), box = await item.boundingBox();
  if (!box) throw new Error("Expected a visible element");
  const pathBefore = await peer.locator(".flow-edge").first().getAttribute("d");
  await page.mouse.move(box.x + 100, box.y + 80); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 140, { steps: 12 });
  await expect.poll(() => position(node(peer, "Decision: Approved?"))).toEqual({ x: before.x + 80, y: before.y + 60 });
  await expect(peer.locator(".remote-cursor")).toContainText(user.username);
  await expect(peer.locator(".flow-edge").first()).not.toHaveAttribute("d", pathBefore!);
  await page.mouse.up(); await saved(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => position(node(peer, "Decision: Approved?"))).toEqual(before);
  await expect(item).toHaveClass(/color-rose/);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(() => position(node(peer, "Decision: Approved?"))).toEqual({ x: before.x + 80, y: before.y + 60 });
  await peer.close();
  await expect(page.locator(".remote-cursor")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("flowchart-desktop.png"), fullPage: true });
});

test("flowchart supports canvas connections, branch labels, node deletion and atomic undo", async ({ page, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await add(page, "process", "Draft"); await add(page, "terminal", "Done");
  await node(page, "Process: Draft").click();
  await page.getByRole("button", { name: "Pick on canvas" }).click();
  await node(page, "Start / End: Done").click();
  await page.getByLabel("Connection label", { exact: true }).fill("Ready"); await saved(page);
  await expect(page.locator(".flow-edge-label")).toHaveText("Ready");
  await node(page, "Process: Draft").click();
  await page.getByRole("button", { name: "Delete node", exact: true }).click();
  await expect(page.locator(".flow-node")).toHaveCount(1);
  await expect(page.locator(".flow-edge")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".flow-node")).toHaveCount(2);
  await expect(page.locator(".flow-edge-label")).toHaveText("Ready");
  await page.getByRole("button", { name: "Draft → Done · Ready", exact: true }).click();
  await page.getByRole("button", { name: "Delete connection", exact: true }).click();
  await expect(page.locator(".flow-edge")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".flow-edge")).toHaveCount(1);
  await node(page, "Process: Draft").click();
  await page.getByLabel("Zoom out", { exact: true }).click();
  await node(page, "Process: Draft").click();
  const before = await position(node(page, "Process: Draft"));
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => position(node(page, "Process: Draft"))).toEqual({ x: before.x + 10, y: before.y });
});

test("flowchart merges offline edits, restores nodes and arrows after restart, and isolates other examples", async ({ page, context, baseURL, backend }) => {
  const { url, roomId } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await add(page, "process", "Draft"); await add(page, "terminal", "Done");
  await connect(page, "Process: Draft", "Done", "Review");
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await node(page, "Process: Draft").click(); await page.keyboard.press("Shift+ArrowRight");
  const moved = await position(node(page, "Process: Draft"));
  await peer.getByRole("button", { name: "Draft → Done · Review", exact: true }).click();
  await peer.getByLabel("Connection label", { exact: true }).fill("Approved"); await saved(peer);
  await page.getByRole("button", { name: "Connect", exact: true }).click(); await saved(page);
  await expect(page.locator(".flow-edge-label")).toHaveText("Approved");
  await page.close(); await peer.close(); await backend.restart();
  const fresh = await context.newPage(); await fresh.goto(url); await saved(fresh);
  await expect.poll(() => position(node(fresh, "Process: Draft"))).toEqual(moved);
  await expect(fresh.locator(".flow-edge-label")).toHaveText("Approved");
  await fresh.getByRole("link", { name: "Try the whiteboard", exact: true }).click();
  await expect(fresh).toHaveURL(`${baseURL}/whiteboard.html?room=${roomId}`); await saved(fresh);
  await expect(fresh.locator(".whiteboard-object")).toHaveCount(0);
});

test("flowchart respects viewer permissions and live downgrades on mobile", async ({ page, browser, baseURL }, testInfo) => {
  const { roomId, url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await add(page, "process", "Draft"); await add(page, "terminal", "Done");
  await connect(page, "Process: Draft", "Done", "Review");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await context.newPage(); const user = await register(viewer.request, baseURL);
    const role = async (value: string) => expect((await api(page.request, baseURL, `/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: value })).ok()).toBe(true);
    await role("viewer"); await viewer.goto(url);
    await expect(viewer.locator("#save-status")).toHaveText("View only");
    await expect(viewer.locator('[data-add="process"]')).toBeDisabled();
    await node(viewer, "Process: Draft").click();
    await expect(viewer.getByLabel("Node text", { exact: true })).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Connect nodes", exact: true })).toBeDisabled();
    const before = await position(node(viewer, "Process: Draft"));
    await viewer.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => position(node(viewer, "Process: Draft"))).toEqual(before);
    await viewer.getByRole("button", { name: "Draft → Done · Review", exact: true }).click();
    await expect(viewer.getByLabel("Connection label", { exact: true })).not.toBeEditable();
    await expect(viewer.getByRole("button", { name: "Delete connection", exact: true })).toBeDisabled();
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.screenshot({ path: testInfo.outputPath("flowchart-mobile.png"), fullPage: true });
    await role("editor"); await viewer.reload(); await saved(viewer);
    await node(viewer, "Process: Draft").click();
    await viewer.getByRole("button", { name: "Pick on canvas" }).click();
    await role("viewer");
    await expect(viewer.getByRole("button", { name: "Pick on canvas" })).toBeDisabled();
    await expect(viewer.locator("#whiteboard-viewport")).not.toHaveClass(/is-connecting/);
  } finally { await context.close(); }
});

test("flowchart arrows stay attached on every interpolated drag frame and reverse paths are distinct", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await add(page, "process", "Draft"); await add(page, "terminal", "Done");
  await connect(page, "Process: Draft", "Done", "Ready");
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  const item = node(page, "Process: Draft"); await item.scrollIntoViewIfNeeded();
  const box = await item.boundingBox();
  if (!box) throw new Error("Expected a visible element");
  await page.mouse.move(box.x + 50, box.y + 40); await page.mouse.down();
  await peer.evaluate(() => {
    const shape = document.querySelector<HTMLElement>('.flow-node')!;
    const arrow = document.querySelector<SVGPathElement>('.flow-edge')!;
    const initial = new DOMMatrixReadOnly(getComputedStyle(shape).transform).m42;
    window.flowMotion = new Promise(resolve => {
      const frames: { y: number; separation: number }[] = [], start = performance.now();
      function sample(time: number) {
        const y = new DOMMatrixReadOnly(getComputedStyle(shape).transform).m42;
        const point = arrow.getPointAtLength(0);
        frames.push({ y: y - initial, separation: Math.abs(point.y - y - shape.offsetHeight / 2) });
        if (time - start < 500) requestAnimationFrame(sample); else resolve(frames);
      }
      requestAnimationFrame(sample);
    });
  });
  await page.mouse.move(box.x + 50, box.y + 100);
  const frames = await peer.evaluate(() => window.flowMotion);
  expect(frames.filter((frame: { y: number; }) => frame.y > 1 && frame.y < 59).length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...frames.map((frame: { separation: any; }) => frame.separation))).toBeLessThan(1);
  await page.mouse.up(); await saved(page);
  await connect(page, "Start / End: Done", "Draft", "Retry");
  await expect(peer.locator('.flow-edge')).toHaveCount(2);
  const curves = await peer.locator('.flow-edge').evaluateAll(paths => paths.map(element => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2); return { x: point.x, y: point.y };
  }));
  expect(Math.hypot(curves[0].x - curves[1].x, curves[0].y - curves[1].y)).toBeGreaterThan(50);
});

test("React Flow handles connect nodes, resize once per gesture, and pan without writing the document", async ({ page, context, baseURL }) => {
  const { url } = await setup(page, baseURL); await page.goto(url); await saved(page);
  await add(page, "process", "Draft"); await add(page, "terminal", "Done");
  const draft = node(page, "Process: Draft"), done = node(page, "Start / End: Done");
  await draft.scrollIntoViewIfNeeded();
  const out = await draft.locator('.react-flow__handle.source').boundingBox();
  const into = await done.locator('.react-flow__handle.target').boundingBox();
  if (!out || !into) throw new Error("Connection handles must be visible");
  await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2); await page.mouse.down();
  await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.flow-edge')).toHaveCount(1);
  await page.getByLabel("Connection label", { exact: true }).fill("Ready"); await saved(page);
  const peer = await context.newPage(); await peer.goto(url); await saved(peer);
  await expect(peer.locator('.flow-edge-label')).toHaveText("Ready");
  await draft.click();
  const id = (await draft.getAttribute('data-id'))!;
  const size = () => draft.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }));
  const originalSize = await size();
  const handle = await draft.locator('.react-flow__resize-control.handle.bottom.right').boundingBox();
  if (!handle) throw new Error("Selected node must have a resize handle");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 30, { steps: 8 });
  await expect.poll(size).toEqual({ width: originalSize.width + 40, height: originalSize.height + 30 });
  const durableSize = await page.evaluate(id => window.synixirTest.room!.doc.getMap<import("yjs").Map<unknown>>("flowchart:nodes:v1").get(id)!.get("size"), id);
  expect(durableSize).toEqual(originalSize);
  await page.mouse.up(); await saved(page);
  await expect.poll(() => node(peer, "Process: Draft").evaluate(element => (element as HTMLElement).offsetWidth)).toBe(originalSize.width + 40);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(size).toEqual(originalSize);
  await expect(peer.locator('.flow-edge-label')).toHaveText("Ready");
  const beforeDocument = await page.evaluate(() => JSON.stringify(window.synixirTest.room!.doc.toJSON()));
  const beforePan = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.locator('#whiteboard-viewport').scrollIntoViewIfNeeded();
  const viewport = await page.locator('#whiteboard-viewport').boundingBox();
  if (!viewport) throw new Error("Canvas must be visible");
  await page.mouse.move(viewport.x + viewport.width - 80, viewport.y + 330); await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width - 130, viewport.y + 280, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.react-flow__viewport')).not.toHaveAttribute('style', beforePan!);
  await page.getByLabel("Zoom out", { exact: true }).click();
  await expect(page.getByLabel("Zoom level", { exact: true })).not.toHaveText("100%");
  expect(await page.evaluate(() => JSON.stringify(window.synixirTest.room!.doc.toJSON()))).toBe(beforeDocument);
  await peer.close();
});
