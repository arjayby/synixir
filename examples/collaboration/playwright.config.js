import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

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
      command: "mix phx.server",
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { MIX_ENV: "test", PHX_SERVER: "true", PORT: "4010" },
      url: "http://127.0.0.1:4010/robots.txt",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      command: "npm run dev -- --port 5174",
      env: { SYNIXIR_ENDPOINT: "http://127.0.0.1:4010" },
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
