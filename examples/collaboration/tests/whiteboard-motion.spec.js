import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { api, register } from "./access-helpers.js";

for (const reducedMotion of [false, true]) test(`remote cursor motion is smooth and stable, reduced motion=${reducedMotion}`, async ({ page, context, baseURL }) => {
  await register(page.request, baseURL);
  const roomId = `motion-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  await page.goto(`${baseURL}/whiteboard.html?room=${roomId}`);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.getByRole("button", { name: "+ Sticky note", exact: true }).click();
  await page.getByLabel("Object text").fill("Stationary note");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const peer = await context.newPage();
  await peer.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await peer.goto(`${baseURL}/whiteboard.html?room=${roomId}`);
  await expect(peer.locator("#save-status")).toHaveText("Saved");
  await page.locator("#whiteboard-viewport").scrollIntoViewIfNeeded();
  const box = await page.locator("#whiteboard-viewport").boundingBox();
  await page.mouse.move(box.x + 80, box.y + 80);
  await expect(peer.locator(".remote-cursor")).toHaveCount(1);
  await peer.evaluate(() => {
    const pointer = document.querySelector(".remote-cursor");
    const participant = document.querySelector("#participants li:last-child");
    const originalX = pointer.getBoundingClientRect().x;
    const frames = [];
    let unrelatedMutations = 0;
    const observer = new MutationObserver(records => { unrelatedMutations += records.length; });
    for (const node of document.querySelectorAll(".whiteboard-object, .object-inspector, #participants")) {
      observer.observe(node, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    window.motionSample = new Promise(resolve => {
      const started = performance.now();
      function frame(time) {
        const current = document.querySelector(".remote-cursor");
        frames.push(current.getBoundingClientRect().x - originalX);
        if (time - started < 500) requestAnimationFrame(frame);
        else {
          observer.disconnect();
          resolve({ frames, unrelatedMutations, samePointer: current === pointer, sameParticipant: participant === document.querySelector("#participants li:last-child") });
        }
      }
      requestAnimationFrame(frame);
    });
  });
  await page.mouse.move(box.x + 280, box.y + 80);
  const sample = await peer.evaluate(() => window.motionSample);
  const intermediate = sample.frames.filter(x => x > 1 && x < 199);
  console.log(`Cursor motion: ${intermediate.length} intermediate frames; cursor retained=${sample.samePointer}; participant retained=${sample.sameParticipant}; unrelated DOM mutations=${sample.unrelatedMutations}`);
  if (reducedMotion) expect(intermediate.length).toBe(0);
  else expect(intermediate.length, "The remote cursor should move on frames between network packets").toBeGreaterThanOrEqual(2);
  expect(sample.frames.at(-1)).toBeCloseTo(200, 0);
  expect(sample.samePointer).toBe(true);
  expect(sample.sameParticipant).toBe(true);
  expect(sample.unrelatedMutations).toBe(0);
  await page.mouse.move(box.x + 280, box.y - 20);
  await expect(peer.locator(".remote-cursor")).toHaveCount(0);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(peer.locator(".remote-selection")).toHaveCount(0);
  await expect(peer.locator("#participants li")).toHaveCount(1);
});

test("remote dragging interpolates the shape and its selection together while local dragging stays immediate", async ({ page, context, baseURL }) => {
  await register(page.request, baseURL);
  const roomId = `drag-motion-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  const url = `${baseURL}/whiteboard.html?room=${roomId}`;
  await page.goto(url);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await page.getByRole("button", { name: "+ Sticky note", exact: true }).click();
  await page.getByLabel("Object text").fill("Moving note");
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const peer = await context.newPage();
  await peer.goto(url);
  await expect(peer.locator("#save-status")).toHaveText("Saved");
  await expect(peer.locator(".remote-selection")).toHaveCount(1);
  const shape = page.getByRole("button", { name: "Sticky note: Moving note", exact: true });
  await shape.scrollIntoViewIfNeeded();
  const box = await shape.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await peer.evaluate(() => {
    const shape = document.querySelector(".whiteboard-object");
    const ring = document.querySelector(".remote-selection");
    const origin = shape.getBoundingClientRect().x;
    const frames = [];
    window.dragMotionSample = new Promise(resolve => {
      const started = performance.now();
      function frame(time) {
        frames.push({ x: shape.getBoundingClientRect().x - origin,
          separation: Math.abs(shape.getBoundingClientRect().x - ring.getBoundingClientRect().x) });
        if (time - started < 500) requestAnimationFrame(frame);
        else resolve({ frames, sameRing: document.querySelector(".remote-selection") === ring });
      }
      requestAnimationFrame(frame);
    });
  });
  await page.mouse.move(box.x + 150, box.y + 30);
  const localX = await shape.evaluate(node => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(node.getBoundingClientRect().x)))));
  expect(localX - box.x).toBeCloseTo(120, 0);
  const sample = await peer.evaluate(() => window.dragMotionSample);
  const intermediate = sample.frames.filter(frame => frame.x > 1 && frame.x < 119);
  console.log(`Drag motion: ${intermediate.length} intermediate frames; max selection separation=${Math.max(...sample.frames.map(frame => frame.separation)).toFixed(2)}px`);
  expect(intermediate.length).toBeGreaterThanOrEqual(2);
  expect(sample.frames.at(-1).x).toBeCloseTo(120, 0);
  expect(Math.max(...sample.frames.map(frame => frame.separation))).toBeLessThan(1);
  expect(sample.sameRing).toBe(true);
  await page.mouse.up();
  await expect(page.locator("#save-status")).toHaveText("Saved");
  const final = await shape.evaluate(node => getComputedStyle(node).transform);
  await expect(peer.locator(".whiteboard-object")).toHaveCSS("transform", final);
});
