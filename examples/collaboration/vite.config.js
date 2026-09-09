import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/demo": {
        target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
      },
      "/socket": {
        target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
        ws: true,
      },
    },
  },
});
