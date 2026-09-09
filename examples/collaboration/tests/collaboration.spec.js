import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";

import { editor, documentText, expectText, insertAtStart, connected } from "./editor-helpers.js";

test("clients in different rooms keep their documents separate", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const run = randomUUID();

  try {
    const [alpha, beta] = await Promise.all(contexts.map((context) => context.newPage()));
    await Promise.all([
      alpha.goto(`${baseURL}/?room=alpha-${run}`),
      beta.goto(`${baseURL}/?room=beta-${run}`),
    ]);
    for (const page of [alpha, beta]) {
      await expect(page.locator("#status")).toHaveText("Connected");
      await expect(page.locator("#participant-count")).toHaveText("1 online");
    }

    await insertAtStart(alpha, "Only alpha");
    await insertAtStart(beta, "Only beta");

    await expect(alpha.locator("#save-status")).toHaveText("Saved");
    await expect(beta.locator("#save-status")).toHaveText("Saved");

    await Promise.all([alpha.reload(), beta.reload()]);
    await expect(alpha.locator("#status")).toHaveText("Connected");
    await expect(beta.locator("#status")).toHaveText("Connected");
    await expectText(alpha, "Only alpha");
    await expectText(beta, "Only beta");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("editing and undo preserve another participant's changes", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
    const url = `${baseURL}/?room=editor-${randomUUID()}`;
    await Promise.all([alice.goto(url), bob.goto(url)]);
    await Promise.all([connected(alice), connected(bob)]);
    await expect(alice.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

    await editor(alice).click();
    await editor(alice).pressSequentially("Hello");
    await expectText(bob, "Hello");
    await expect(bob.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await editor(bob).click();
    await editor(bob).press("ControlOrMeta+End");
    await bob.keyboard.insertText(" from Bob");
    await expectText(alice, "Hello from Bob");

    await alice.getByRole("button", { name: "Undo", exact: true }).click();
    await expectText(alice, " from Bob");
    await expectText(bob, " from Bob");
    await editor(alice).press("ControlOrMeta+Shift+z");
    await expectText(bob, "Hello from Bob");

    // Replace a selection, then insert multiple lines as a paste would.
    await editor(alice).press("ControlOrMeta+Home");
    for (let i = 0; i < 5; i++) await editor(alice).press("Shift+ArrowRight");
    await alice.keyboard.insertText("Hi 👋");
    await editor(alice).press("ControlOrMeta+End");
    await alice.keyboard.insertText("\nA second line\n第三行");
    await expectText(bob, "Hi 👋 from Bob\nA second line\n第三行");
    await expect(alice.locator("#save-status")).toHaveText("Saved");
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test("awareness shows participants and selections and removes them on departure", async ({ browser, baseURL, backend }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
    const url = `${baseURL}/?room=presence-${randomUUID()}`;
    await Promise.all([alice.goto(url), bob.goto(url)]);
    await Promise.all([connected(alice), connected(bob)]);
    const aliceName = await alice.locator("#your-name").textContent();
    const bobName = await bob.locator("#your-name").textContent();
    await expect(alice.getByRole("list", { name: "Participants" })).toContainText(bobName);
    await expect(bob.getByRole("list", { name: "Participants" })).toContainText(aliceName);
    await expect(bob.locator("#participant-count")).toHaveText("2 online");
    await insertAtStart(alice, "Hello everyone");
    await expectText(bob, "Hello everyone");
    await editor(alice).press("ControlOrMeta+Home");
    for (let i = 0; i < 5; i++) await editor(alice).press("Shift+ArrowRight");
    await expect(bob.locator(".cm-ySelection")).toHaveText("Hello");
    await expect(bob.locator(".cm-ySelectionInfo")).toHaveText(aliceName);

    // Relative cursor positions must continue to select Hello after an insert.
    await insertAtStart(bob, "Before ");
    await expectText(alice, "Before Hello everyone");
    await expect(bob.locator(".cm-ySelection")).toHaveText("Hello");
    await alice.getByLabel("Room ID").focus();
    await expect(bob.locator(".cm-ySelectionCaret")).toHaveCount(0);

    await alice.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(bob.locator("#participant-count")).toHaveText("1 online");
    await expect(alice.locator("#participant-count")).toHaveText("Offline");
    await expect(alice.locator("#participants li")).toHaveCount(1);
    await alice.getByRole("button", { name: "Connect", exact: true }).click();
    await connected(alice);
    await expect(bob.locator("#participant-count")).toHaveText("2 online");
    await backend.restart();
    await Promise.all([connected(alice), connected(bob)]);
    await expect(alice.locator("#participant-count")).toHaveText("2 online");
    await expect(bob.locator("#participant-count")).toHaveText("2 online");
    await expect(alice.locator("#save-status")).toHaveText("Saved");
    await alice.close();
    await expect(bob.locator("#participant-count")).toHaveText("1 online");
    await expect(bob.locator(".cm-ySelectionCaret")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test("offline edits prompt before leaving and survive cancelling room navigation", async ({ page, baseURL }) => {
  const room = `leave-${randomUUID()}`;
  await page.goto(`${baseURL}/?room=${room}`);
  await connected(page);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await insertAtStart(page, "Keep this draft");
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  await page.getByLabel("Room ID").fill(`other-${randomUUID()}`);
  const dialogPromise = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Open room", exact: true }).click({ noWaitAfter: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(page).toHaveURL(`${baseURL}/?room=${room}`);
  await expectText(page, "Keep this draft");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#save-status")).toHaveText("Saved");
});

test("independent clients merge concurrent text edits through Phoenix and Yex", async ({
  browser,
  baseURL,
}) => {
  // Separate browser contexts cannot exchange data through local browser storage.
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const roomUrl = `${baseURL}/?room=merge-${randomUUID()}`;

  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await Promise.all([alice.goto(roomUrl), bob.goto(roomUrl)]);
    await expect(alice.locator("#status")).toHaveText("Connected");
    await expect(bob.locator("#status")).toHaveText("Connected");

    await insertAtStart(alice, "Hello 👋");
    await expectText(bob, "Hello 👋");

    // Both edits start from the same document state before either client sees
    // the other's change. Reconnection must merge them without losing text.
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(page.locator("#status")).toHaveText("Disconnected");
    }
    await insertAtStart(alice, "A ");
    await insertAtStart(bob, "B ");
    await expectText(alice, "A Hello 👋");
    await expectText(bob, "B Hello 👋");

    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.locator("#status")).toHaveText("Connected");
    }
    await expectText(alice, /^(A B |B A )Hello 👋$/);
    const mergedText = await documentText(alice);
    await expectText(bob, mergedText);
    await expect(alice.locator("#save-status")).toHaveText("Saved");
    await expect(bob.locator("#save-status")).toHaveText("Saved");

    await aliceContext.close();
    await bobContext.close();

    // A new client must obtain the merged state from Yex after both original
    // clients have gone away, proving the backend is more than a message relay.
    const newcomerContext = await browser.newContext();
    try {
      const newcomer = await newcomerContext.newPage();
      await newcomer.goto(roomUrl);
      await expect(newcomer.locator("#status")).toHaveText("Connected");
      await expectText(newcomer, mergedText);
    } finally {
      await newcomerContext.close();
    }
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("saved inserts and deletions survive a killed server without help from old clients", async ({
  browser, baseURL, backend,
}) => {
  const roomUrl = `${baseURL}/?room=restart-${randomUUID()}`;
  const writerContext = await browser.newContext();
  try {
    const writer = await writerContext.newPage();
    await writer.goto(roomUrl);
    await expect(writer.locator("#status")).toHaveText("Connected");
    await insertAtStart(writer, "👋Saved after restart");
    await expect(writer.locator("#save-status")).toHaveText("Saved");
    await editor(writer).press("ControlOrMeta+Home");
    await editor(writer).press("Delete");
    await expectText(writer, "Saved after restart");
    await expect(writer.locator("#save-status")).toHaveText("Saved");
  } finally {
    await writerContext.close();
  }

  await backend.restart();
  const readerContext = await browser.newContext();
  try {
    const reader = await readerContext.newPage();
    await reader.goto(roomUrl);
    await expect(reader.locator("#status")).toHaveText("Connected");
    await expectText(reader, "Saved after restart");
    await reader.getByRole("button", { name: "Disconnect", exact: true }).click();
    await insertAtStart(reader, "Offline ");
    await expect(reader.locator("#save-status")).toHaveText("Unsaved changes");
    await backend.restart();
    await reader.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(reader.locator("#status")).toHaveText("Connected");
    await expect(reader.locator("#save-status")).toHaveText("Saved");
  } finally {
    await readerContext.close();
  }

  await backend.restart();
  const finalContext = await browser.newContext();
  try {
    const page = await finalContext.newPage();
    await page.goto(roomUrl);
    await expectText(page, "Offline Saved after restart");
  } finally {
    await finalContext.close();
  }
});
