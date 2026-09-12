import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "synixir-client-consumer-"));
const run = (command: string, args: string[], cwd = temporary) => execFileSync(command, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
try {
  const [pack] = JSON.parse(run("npm", ["pack", "--workspace", "@synixir/client", "--json", "--pack-destination", temporary], root));
  assert.ok(pack.files.some((file: { path: string; }) => file.path === "dist/index.d.ts"));
  assert.ok(pack.files.some((file: { path: string; }) => file.path === "README.md"));
  assert.ok(pack.files.every((file: { path: string; }) => /^(dist\/|README\.md$|package\.json$)/.test(file.path)));
  const example = JSON.parse(readFileSync(join(root, "examples/collaboration/package.json"), "utf8"));
  const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
    "@synixir/client": `file:./${pack.filename}`, yjs: example.dependencies.yjs,
    typescript: workspace.devDependencies.typescript, vite: workspace.devDependencies.vite,
  } }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  writeFileSync(join(temporary, "consumer.ts"), readFileSync(join(root, "packages/client/test/consumer.ts")));
  for (const [module, moduleResolution] of [["NodeNext", "NodeNext"], ["ESNext", "bundler"]]) {
    run("node", ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", module,
      "--moduleResolution", moduleResolution, "consumer.ts"]);
  }
  run("node", ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { SynixirRoom } from "@synixir/client";
    import * as Y from "yjs";
    const room = new SynixirRoom({ roomId: "pack", userId: "account", serverUrl: "http://localhost" });
    assert.ok(room.doc instanceof Y.Doc);
    assert.equal(createRequire(import.meta.resolve("@synixir/client")).resolve("yjs"), createRequire(import.meta.url).resolve("yjs"));
    await room.destroy();
    await assert.rejects(import("@synixir/client/src/access.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  `]);
  writeFileSync(join(temporary, "index.html"), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(temporary, "main.js"), `
    import { SynixirRoom } from "@synixir/client";
    const room = new SynixirRoom({ roomId: "notes", userId: "account" });
    room.subscribe(state => document.body.dataset.connection = state.connection);
    window.addEventListener("pagehide", () => { void room.destroy(); });
  `);
  run("node", ["node_modules/vite/bin/vite.js", "build"]);
  console.log(`Verified ${pack.filename}: packed files, ESM import, shared Yjs, NodeNext/bundler types, and Vite build.`);
} catch (error) {
  if (error instanceof Error && "stdout" in error && error.stdout) process.stderr.write(String(error.stdout));
  if (error instanceof Error && "stderr" in error && error.stderr) process.stderr.write(String(error.stderr));
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
