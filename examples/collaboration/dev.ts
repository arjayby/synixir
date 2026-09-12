import { createServer } from "node:http";
import next from "next";
import httpProxy from "http-proxy";
const index = process.argv.indexOf("--port");
const port = index >= 0 ? Number(process.argv[index + 1]) : 5173;
const app = next({ dev: true, hostname: "127.0.0.1", port });
const proxy = httpProxy.createProxyServer({
  target: process.env.SYNIXIR_ENDPOINT ?? "http://127.0.0.1:4000",
  ws: true,
});
proxy.on("error", (_error, _request, response) => {
  if (response && "writeHead" in response) {
    response.writeHead(502);
    response.end("Backend unavailable");
  }
});
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => {
  if (/^\/(api|socket)(\/|\?|$)/.test(request.url ?? "")) return proxy.web(request, response);
  // Keep the published example URLs working in development and static exports.
  request.url = request.url?.replace(/^([^?]*)\.html(?=\?|$)/, "$1");
  void handle(request, response);
});
server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/socket")) proxy.ws(request, socket, head);
  else void app.getUpgradeHandler()(request, socket, head);
});
server.listen(port, "127.0.0.1", () => console.log(`Synixir examples: http://127.0.0.1:${port}`));
async function stop() {
  proxy.close();
  server.close();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
