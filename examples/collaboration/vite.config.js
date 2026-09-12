import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        collaboration: fileURLToPath(new URL("./index.html", import.meta.url)),
        settings: fileURLToPath(new URL("./sdk.html", import.meta.url)),
        kanban: fileURLToPath(new URL("./kanban.html", import.meta.url)),
        flowchart: fileURLToPath(new URL("./flowchart.html", import.meta.url)),
        whiteboard: fileURLToPath(new URL("./whiteboard.html", import.meta.url)),
        richText: fileURLToPath(new URL("./rich-text.html", import.meta.url)),
        multiplayerForm: fileURLToPath(new URL("./multiplayer-form.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
      },
      "/socket": {
        target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
        ws: true,
      },
    },
  },
});
