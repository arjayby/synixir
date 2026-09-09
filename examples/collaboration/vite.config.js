import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/socket": {
        target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
        ws: true,
      },
    },
  },
});
