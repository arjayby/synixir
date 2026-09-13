import { defineConfig } from "@playwright/test";
import { backendURL, frontendPort, frontendURL } from "./tests/ports.ts";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: frontendURL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `npm run dev -- --port ${frontendPort}`,
      env: { NEXT_PUBLIC_SYNIXIR_BROWSER_TEST: "true", SYNIXIR_ENDPOINT: backendURL },
      url: frontendURL,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
