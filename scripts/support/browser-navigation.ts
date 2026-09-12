import type { Page } from "@playwright/test";
import { setTimeout } from "node:timers/promises";

export async function navigateStaging(page: Pick<Page, "goto">, url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url);
    } catch (error) {
      // Chromium can report a network change as the staging containers restart.
      if (
        attempt >= 3 ||
        !(error instanceof Error) ||
        !error.message.includes("net::ERR_NETWORK_CHANGED")
      ) {
        throw error;
      }
      await setTimeout(100 * attempt);
    }
  }
}
