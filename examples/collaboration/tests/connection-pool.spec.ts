import { request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { api, register } from "./access-helpers.ts";
import { connected } from "./editor-helpers.ts";

test("open rooms do not exhaust database connections for new accounts", async ({ context, baseURL }) => {
  await register(context.request, baseURL);
  const newcomer = await request.newContext();
  const pages = [];
  try {
    // Two documents and their channels outlive their queries. If the test
    // server uses Sandbox, these four processes retain the entire small pool.
    for (let index = 0; index < 2; index++) {
      const room = `pool-${randomUUID()}`;
      expect((await api(context.request, baseURL, "/api/rooms", "POST", { room_id: room })).ok()).toBe(true);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(`${baseURL}/?room=${room}`);
      await connected(page);
    }
    await register(newcomer, baseURL);
  } finally {
    await Promise.all(pages.map(page => page.close()));
    await newcomer.dispose();
  }
});
