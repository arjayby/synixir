import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -- --port 5174",
      env: { NEXT_PUBLIC_SYNIXIR_BROWSER_TEST: "true", SYNIXIR_ENDPOINT: "http://127.0.0.1:4010" },
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
