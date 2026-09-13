import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { changeConnection, api, register } from "./access-helpers.ts";
import { drawShape, scene } from "./whiteboard-helpers.ts";

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });

async function toggleTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: `Use ${theme} theme`, exact: true }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
  await expect(page.getByRole("menu")).toBeHidden();
}

// Resolve modern CSS colors in the browser and measure the actual foreground/background pair.
async function checkSurface(page: Page, selector: string, theme: "light" | "dark", checkBackground = true) {
  const { background, contrast } = await page.locator(selector).first().evaluate(element => {
    const context = document.createElement("canvas").getContext("2d")!;
    const paint = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    };
    const luminance = () => {
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const surfaces = [];
    for (let surface: Element | null = element; surface; surface = surface.parentElement) surfaces.unshift(getComputedStyle(surface).backgroundColor);
    surfaces.forEach(paint);
    const background = luminance();
    paint(getComputedStyle(element).color);
    const foreground = luminance();
    return { background, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
  });
  expect(contrast, `${selector} text contrast in ${theme} mode`).toBeGreaterThanOrEqual(4.5);
  if (!checkBackground) return;
  if (theme === "dark") expect(background, selector).toBeLessThan(0.15);
  else expect(background, selector).toBeGreaterThan(0.5);
}

const examples = [
  { path: "/", name: "text", surface: ".document-panel", editor: ".cm-editor" },
  { path: "/kanban", name: "kanban", surface: ".kanban-card", editor: ".kanban-board" },
  { path: "/whiteboard", name: "whiteboard", surface: ".document-panel", editor: ".excalidraw" },
  { path: "/rich-text", name: "rich-text", surface: ".format-toolbar", editor: ".tiptap" },
  { path: "/multiplayer-form", name: "form", surface: ".brief-text", editor: ".shared-form" },
  { path: "/flowchart", name: "flowchart", surface: ".flow-shape", editor: ".react-flow" },
  { path: "/table", name: "table", surface: ".shared-table", editor: ".shared-table" },
];

async function populate(page: Page, name: string) {
  if (name === "text") await page.getByRole("textbox", { name: "Shared document", exact: true }).fill("A shared plan, in any theme.");
  if (name === "kanban") {
    await page.getByRole("button", { name: "Add card to Backlog", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Review the playground");
    await page.getByLabel("Description", { exact: true }).fill("Check every example in light and dark mode.");
    await page.getByRole("button", { name: "Close card", exact: true }).click();
  }
  if (name === "whiteboard") { await drawShape(page); await drawShape(page, "ellipse", 240); }
  if (name === "rich-text") {
    await page.getByRole("textbox", { name: "Rich text document", exact: true }).fill("A shared plan, in any theme.");
    await page.getByLabel("Text style", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Bold", exact: true }).click();
  }
  if (name === "form") {
    await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Playground theme review");
    await page.getByRole("textbox", { name: "What are we making?", exact: true }).fill("A workspace that stays readable in light and dark mode.");
    await page.getByRole("checkbox", { name: "Website", exact: true }).check();
  }
  if (name === "flowchart") {
    for (const [kind, label, color] of [["process", "Draft", "blue"], ["decision", "Ready?", "yellow"], ["terminal", "Done", "mint"], ["process", "Review", "rose"], ["process", "Archive", "white"]]) {
      await page.locator(`[data-add="${kind}"]`).click();
      await page.getByLabel("Node text", { exact: true }).fill(label);
      await page.getByLabel("Node color", { exact: true }).selectOption(color);
    }
    await page.getByRole("group", { name: "Process: Draft", exact: true }).click();
    await page.getByLabel("Connect to", { exact: true }).selectOption({ label: "Ready?" });
    await page.getByLabel("Branch label", { exact: true }).fill("Review");
    await page.getByRole("button", { name: "Connect nodes", exact: true }).click();
    await page.getByRole("button", { name: "Fit diagram", exact: true }).click();
  }
  if (name === "table") {
    await page.getByRole("gridcell", { name: /^A1:/ }).dblclick();
    await page.getByRole("textbox", { name: "Edit A1", exact: true }).fill("Review the playground");
    await page.keyboard.press("Escape");
  }
  await expect(page.locator("#save-status")).toHaveText("Saved");
}

for (const example of examples) test(`${example.name} follows the playground theme without changing the document`, async ({ page, baseURL }, testInfo) => {
  await register(page.request, baseURL);
  const roomId = `theme-${randomUUID()}`;
  expect((await api(page.request, baseURL, "/api/rooms", "POST", { room_id: roomId })).ok()).toBe(true);
  await page.goto(`${baseURL}${example.path}?room=${roomId}`);
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await populate(page, example.name);
  if (example.name === "text") {
    await changeConnection(page, "Disconnect");
    await page.getByRole("textbox", { name: "Shared document", exact: true }).press("ControlOrMeta+End");
    await page.keyboard.insertText(" Keep this unsaved draft.");
    await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  }
  const editor = await page.locator(example.editor).elementHandle();
  const document = await page.evaluate(() => window.synixirTest.room!.doc.toJSON());
  const drawing = example.name === "whiteboard" ? await scene(page) : null;
  const viewport = example.name === "flowchart" ? await page.locator(".react-flow__viewport").getAttribute("style") : null;
  const updates = await page.evaluateHandle(() => {
    const state = { count: 0 };
    window.synixirTest.room!.doc.on("update", () => state.count++);
    return state;
  });

  for (const theme of ["light", "dark", "light", "dark"] as const) {
    if (theme !== "light" || await page.locator("html").evaluate(element => element.classList.contains("dark"))) await toggleTheme(page, theme);
    await checkSurface(page, example.surface, theme);
    if (example.name === "kanban") {
      await page.locator(".card-open").hover();
      await checkSurface(page, ".card-open", theme);
    }
    if (example.name === "text") {
      await page.getByRole("textbox", { name: "Shared document", exact: true }).press("ControlOrMeta+a");
      await checkSurface(page, ".cm-editor.cm-focused .cm-selectionBackground", theme);
      await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
    }
    if (example.name === "table") {
      await expect(page.locator(".shared-table")).toHaveCSS("color-scheme", theme);
      const row = '.shared-table [role="row"]:has(.table-cell)';
      await page.locator(row).first().hover();
      await checkSurface(page, row, theme);
    }
    if (example.name === "rich-text") await checkSurface(page, '.format-toolbar button[aria-pressed="true"]', theme, false);
    if (example.name === "whiteboard") {
      await expect.poll(() => page.evaluate(() => window.synixirWhiteboardTest!.getAppState().theme)).toBe(theme);
      if (theme === "dark") await expect(page.locator(".excalidraw")).toHaveClass(/theme--dark/);
      else await expect(page.locator(".excalidraw")).not.toHaveClass(/theme--dark/);
      expect(await scene(page)).toEqual(drawing);
    }
    if (example.name === "flowchart") {
      await expect(page.locator(".react-flow")).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await checkSurface(page, ".react-flow", theme);
      for (const color of ["blue", "yellow", "mint", "rose", "white"]) await checkSurface(page, `.color-${color} .flow-shape`, theme);
      expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(viewport);
      await page.locator('.flow-connections button[aria-pressed="true"]').hover();
      await checkSurface(page, '.flow-connections button[aria-pressed="true"]', theme);
    }
    expect(await page.locator(example.editor).evaluate((element, original) => element === original, editor)).toBe(true);
    expect(await page.evaluate(() => window.synixirTest.room!.doc.toJSON())).toEqual(document);
    expect(await updates.evaluate(state => state.count)).toBe(0);
    await page.locator("#editor").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`${example.name}-${theme}.png`), fullPage: true });
  }

  if (example.name === "text") {
    await changeConnection(page, "Connect");
    await expect(page.locator("#save-status")).toHaveText("Saved");
  }
  // Saved preferences must reach lazily mounted editors even when the OS disagrees.
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("#save-status")).toHaveText("Saved");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await checkSurface(page, example.surface, "dark");
  if (example.name === "whiteboard") await expect.poll(() => page.evaluate(() => window.synixirWhiteboardTest!.getAppState().theme)).toBe("dark");
  if (example.name === "flowchart") await expect(page.locator(".react-flow")).toHaveClass(/\bdark\b/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath(`${example.name}-dark-mobile.png`), fullPage: true });
});
