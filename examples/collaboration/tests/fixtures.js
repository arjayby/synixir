import { test as base, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../../..", import.meta.url));
const env = { ...process.env, MIX_ENV: "test", PHX_SERVER: "true", PORT: "4010" };
const endpoint = "http://127.0.0.1:4010/robots.txt";

export const test = base.extend({
  backend: [async ({}, use) => {
    execFileSync("mix", ["ecto.create", "--quiet"], { cwd, env });
    execFileSync("mix", ["ecto.migrate", "--quiet"], { cwd, env });
    let child;
    let exited;
    let output = "";

    async function ready() {
      try {
        return (await fetch(endpoint, { signal: AbortSignal.timeout(500) })).ok;
      } catch {
        return false;
      }
    }

    async function start() {
      if (await ready()) throw new Error("Port 4010 is already in use");
      output = "";
      child = spawn("mix", ["phx.server"], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      exited = once(child, "exit");
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", chunk => { output = (output + chunk).slice(-12000); });
      }
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(output);
        return ready();
      }, { timeout: 30_000, message: "Phoenix test server did not start" }).toBe(true);
    }

    async function stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        // Kill only the process group this fixture created. No shutdown hooks
        // can save the document on behalf of the implementation under test.
        process.kill(-child.pid, "SIGKILL");
        await exited;
      }
    }

    try {
      await start();
      await use({
        restart: async () => { await stop(); await start(); },
        compact: room => {
          // Use the production store against committed test data. Pass the room
          // through the environment so it can never become executable code.
          const maintenanceEnv = { ...env, SYNIXIR_TEST_ROOM: room };
          delete maintenanceEnv.PHX_SERVER;
          return execFileSync("mix", ["run", "-e", `
            room = System.fetch_env!("SYNIXIR_TEST_ROOM")
            :ok = Synixir.Documents.Store.compact(room)
            %{rows: [[count]]} = Synixir.Repo.query!(
              "SELECT count(*) FROM document_snapshots WHERE room_id = $1", [room])
            if count != 1, do: raise("snapshot missing")
          `], { cwd, env: maintenanceEnv }).toString();
        },
      });
    } finally {
      await stop();
    }
  }, { scope: "worker", auto: true }],
});

export { expect };
