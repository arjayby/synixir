import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { changeConnection, api, register } from "./access-helpers.ts";
import { connected, insertAtStart } from "./editor-helpers.ts";

test("playground menus, room tabs, connection alerts and save help work together", async ({
  page,
  baseURL,
}, testInfo) => {
  await register(page.request, baseURL);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseURL!);
  await page
    .getByRole("button", { name: "Choose a room", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Room info", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Create a room", exact: true }).click();
  const roomId = `playground-${randomUUID()}`;
  await page.getByLabel("New room ID").fill(roomId);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await connected(page);
  await expect(page.locator(".footer-connection button")).toHaveCount(1);
  await insertAtStart(page, "A shared playground draft");
  await expect(page.locator("#save-status")).toHaveText("Saved");

  await page
    .getByRole("button", { name: "Connection status", exact: true })
    .click();
  const alert = page.getByRole("alertdialog", {
    name: "Connection status",
    exact: true,
  });
  await expect(alert).toContainText("Connected");
  await alert.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(alert).toBeHidden();
  await expect(page.locator("#status")).toHaveText("Disconnected");
  await expect(page.locator(".footer-connection button")).toHaveCount(1);
  await insertAtStart(page, "Offline edit. ");
  await page
    .getByRole("button", { name: "Save status and help", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Offline edits stay in this tab until you reconnect.",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await changeConnection(page, "Connect");
  await connected(page);
  await expect(page.locator("#save-status")).toHaveText("Saved");

  await page
    .getByRole("button", { name: "Select example", exact: true })
    .click();
  await expect(page.getByRole("menuitem")).toHaveCount(7);
  await expect(
    page.getByRole("menuitem", { name: "Kanban board", exact: true }),
  ).toHaveAttribute("href", `/kanban?room=${roomId}`);
  await page
    .getByRole("menuitem", { name: "Kanban board", exact: true })
    .click();
  await connected(page);
  await expect(page.locator(".kanban-board")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("playground-desktop.png"),
  });

  await page.getByRole("button", { name: `Room details: ${roomId}` }).click();
  await expect(page.getByRole("dialog")).toContainText("1 member · 1 online");
  await expect(page.getByRole("list", { name: "Room members" })).toContainText(
    "Online",
  );
  await page.getByRole("tab", { name: "Create a room", exact: true }).click();
  await page.getByLabel("New room ID").fill(roomId);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That room ID is unavailable.",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("playground-mobile.png") });
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Use dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#auth-panel")).toBeVisible();
});

test("viewers see the full member roster and live online status without access controls", async ({
  page,
  browser,
  baseURL,
}) => {
  const owner = await register(page.request, baseURL);
  const roomId = `roster-${randomUUID()}`;
  expect(
    (
      await api(page.request, baseURL, "/api/rooms", "POST", {
        room_id: roomId,
      })
    ).ok(),
  ).toBe(true);
  const viewerContext = await browser.newContext();
  try {
    const viewer = await register(viewerContext.request, baseURL);
    expect(
      (
        await api(
          page.request,
          baseURL,
          `/api/rooms/${roomId}/members/${viewer.username}`,
          "PUT",
          { role: "viewer" },
        )
      ).ok(),
    ).toBe(true);
    const reader = await viewerContext.newPage();
    await reader.goto(`${baseURL}/?room=${roomId}`);
    await connected(reader);
    await reader
      .getByRole("button", { name: `Room details: ${roomId}` })
      .click();
    const roster = reader.getByRole("list", { name: "Room members" });
    await expect(roster.getByRole("listitem")).toHaveCount(2);
    await expect(
      roster.getByRole("listitem").filter({ hasText: owner.username }),
    ).toContainText("Offline");
    await expect(
      roster.getByRole("listitem").filter({ hasText: viewer.username }),
    ).toContainText("Online");
    await page.goto(`${baseURL}/?room=${roomId}`);
    await connected(page);
    await expect(
      roster.getByRole("listitem").filter({ hasText: owner.username }),
    ).toContainText("Online");
    await reader.getByRole("button", { name: "Close", exact: true }).click();
    await reader
      .getByRole("button", { name: "Manage access", exact: true })
      .click();
    await expect(reader.getByRole("dialog")).toContainText(
      "Only room owners can change access.",
    );
    await expect(
      reader.getByRole("button", { name: "Grant access", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await api(
          viewerContext.request,
          baseURL,
          `/api/rooms/${roomId}/members/${owner.username}`,
          "PUT",
          { role: "viewer" },
        )
      ).status(),
    ).toBe(403);
  } finally {
    await viewerContext.close();
  }
});
