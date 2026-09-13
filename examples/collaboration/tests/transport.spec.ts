import { createConnection } from "node:net";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { test, expect } from "./fixtures.ts";
import { backendPort, backendURL, frontendURL } from "./ports.ts";

test("the WebSocket handshake rejects an untrusted browser origin", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(`${backendURL}/socket/websocket?vsn=2.0.0`, {
      headers: {
        Origin: "https://untrusted.example",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("Origin check timed out")));
    req.end();
  });
  expect(status).toBe(403);
});

function frame(size: number, opcode: number, final: boolean) {
  const bytes = Buffer.alloc(14 + size);
  bytes[0] = (final ? 0x80 : 0) | opcode;
  bytes[1] = 0x80 | 127;
  bytes.writeBigUInt64BE(BigInt(size), 2);
  const mask = randomBytes(4);
  mask.copy(bytes, 10);
  // A masked payload of zero bytes is enough to exercise the transport limit.
  for (let index = 0; index < size; index++) bytes[14 + index] = mask[index % 4];
  return bytes;
}

for (const fragmented of [false, true]) {
  test(`transport rejects an oversized ${fragmented ? "fragmented message" : "frame"} before channel processing`, async () => {
    const socket = createConnection({ host: "127.0.0.1", port: backendPort });
    let timeout;
    try {
      const code = await new Promise((resolve, reject) => {
        let incoming = Buffer.alloc(0);
        let upgraded = false;
        timeout = setTimeout(() => reject(new Error("WebSocket limit did not close the connection")), 5_000);
        socket.on("error", reject);
        socket.on("close", () => reject(new Error("Connection closed without a WebSocket close frame")));
        socket.on("connect", () => socket.write([
          "GET /socket/websocket?vsn=2.0.0 HTTP/1.1",
          `Host: 127.0.0.1:${backendPort}`,
          `Origin: ${frontendURL}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "", "",
        ].join("\r\n")));
        socket.on("data", chunk => {
          incoming = Buffer.concat([incoming, chunk]);
          if (!upgraded) {
            const end = incoming.indexOf("\r\n\r\n");
            if (end < 0) return;
            if (!incoming.toString().startsWith("HTTP/1.1 101")) return reject(new Error("WebSocket upgrade failed"));
            incoming = incoming.subarray(end + 4);
            upgraded = true;
            if (fragmented) {
              socket.write(frame(1_048_600, 2, false));
              socket.write(frame(1_048_600, 0, true));
            } else {
              socket.write(frame(2_097_153, 2, true));
            }
          }
          if (incoming.length >= 4) {
            if ((incoming[0] & 0x0f) !== 8) return reject(new Error("Expected a WebSocket close frame"));
            resolve(incoming.readUInt16BE(2));
          }
        });
      });
      expect(code).toBe(1009);
    } finally {
      clearTimeout(timeout);
      socket.destroy();
    }
  });
}
