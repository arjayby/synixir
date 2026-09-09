import { test, expect } from "@playwright/test";

test("clients in different rooms keep their documents separate", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);

  try {
    const [alpha, beta] = await Promise.all(contexts.map((context) => context.newPage()));
    await Promise.all([
      alpha.goto(`${baseURL}/?room=alpha`),
      beta.goto(`${baseURL}/?room=beta`),
    ]);
    for (const page of [alpha, beta]) {
      await expect(page.getByRole("status")).toHaveText("Connected");
    }

    await alpha.getByLabel("Text to insert").fill("Only alpha");
    await alpha.getByRole("button", { name: "Insert at start" }).click();
    await beta.getByLabel("Text to insert").fill("Only beta");
    await beta.getByRole("button", { name: "Insert at start" }).click();

    await Promise.all([alpha.reload(), beta.reload()]);
    await expect(alpha.getByRole("status")).toHaveText("Connected");
    await expect(beta.getByRole("status")).toHaveText("Connected");
    await expect(alpha.getByLabel("Shared document")).toHaveValue("Only alpha");
    await expect(beta.getByLabel("Shared document")).toHaveValue("Only beta");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("independent clients merge concurrent text edits through Phoenix and Yex", async ({
  browser,
  baseURL,
}) => {
  // Separate browser contexts cannot exchange data through local browser storage.
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();

  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await Promise.all([alice.goto(baseURL), bob.goto(baseURL)]);
    await expect(alice.getByRole("status")).toHaveText("Connected");
    await expect(bob.getByRole("status")).toHaveText("Connected");

    await alice.getByLabel("Text to insert").fill("Hello 👋");
    await alice.getByRole("button", { name: "Insert at start" }).click();
    await expect(bob.getByLabel("Shared document")).toHaveValue("Hello 👋");

    // Both edits start from the same document state before either client sees
    // the other's change. Reconnection must merge them without losing text.
    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Disconnected");
    }
    await alice.getByLabel("Text to insert").fill("A ");
    await alice.getByRole("button", { name: "Insert at start" }).click();
    await bob.getByLabel("Text to insert").fill("B ");
    await bob.getByRole("button", { name: "Insert at start" }).click();
    await expect(alice.getByLabel("Shared document")).toHaveValue("A Hello 👋");
    await expect(bob.getByLabel("Shared document")).toHaveValue("B Hello 👋");

    for (const page of [alice, bob]) {
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Connected");
    }
    await expect(alice.getByLabel("Shared document")).toHaveValue(/^(A B |B A )Hello 👋$/);
    const mergedText = await alice.getByLabel("Shared document").inputValue();
    await expect(bob.getByLabel("Shared document")).toHaveValue(mergedText);

    await aliceContext.close();
    await bobContext.close();

    // A new client must obtain the merged state from Yex after both original
    // clients have gone away, proving the backend is more than a message relay.
    const newcomerContext = await browser.newContext();
    try {
      const newcomer = await newcomerContext.newPage();
      await newcomer.goto(baseURL);
      await expect(newcomer.getByRole("status")).toHaveText("Connected");
      await expect(newcomer.getByLabel("Shared document")).toHaveValue(mergedText);
    } finally {
      await newcomerContext.close();
    }
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
