// Invoked by database.exs, which owns the isolated database and server lifecycle.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { SynixirRoom } from "@synixir/client";

assert.match(process.env.SYNIXIR_OPERATIONS_DATABASE ?? "", /^synixir_load_[a-f0-9]{12}$/);
const [port, count, roomCount, writes] = process.argv.slice(2).map(Number);
// The provider registers one exit handler per Node client and removes it on destroy.
const exitListeners = process.listenerCount("exit");
const listenerLimit = process.getMaxListeners();
process.setMaxListeners(listenerLimit + count + 2);
const origin = `http://127.0.0.1:${port}`;
interface Client { room: SynixirRoom; api: ReturnType<typeof account>; user: { id: string }; roomId: string; index: number }
const clients: Client[] = [];
const groups: Client[][] = Array.from({ length: roomCount }, () => []);
const saveMs: number[] = [], convergeMs: number[] = [], connectMs: number[] = [];
let updateBytes = 0;
const cpuStart = process.cpuUsage();
const started = performance.now();

function account() {
  const cookies = new Map<string, string>();
  let csrf: string | undefined;
  return async (path: string|URL, method = "GET", body?: Record<string, unknown>, signal = AbortSignal.timeout(10000)) => {
    const response = await fetch(new URL(path, origin), { method, signal,
      headers: { "Content-Type": "application/json", Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error}`);
    if (result.csrf_token) csrf = result.csrf_token;
    return result;
  };
}

async function until(predicate: () => boolean, label: string, timeout = 45000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    for (const { room } of clients) {
      if (room.state.saveStatus === "failed") throw new Error(`Save rejected: ${room.state.saveError}`);
      if (room.state.connection === "error") throw new Error(`Connection failed: ${room.state.error?.code}`);
    }
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}

async function metrics() {
  const response = await fetch(`${origin}/metrics`, {
    headers: { Authorization: `Bearer ${process.env.SYNIXIR_METRICS_TOKEN}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const value = (name: string) => Number(text.match(new RegExp(`^${name} (.+)$`, "m"))?.[1] ?? 0);
  return { text, memory_bytes: value("synixir_vm_memory_bytes"), run_queue: value("synixir_vm_run_queue"),
    active_channels: value("synixir_channels_active"), active_documents: value("synixir_documents_active"),
    database_queue_seconds_sum: value("synixir_database_queue_seconds_sum"),
    database_queue_count: value("synixir_database_queue_seconds_count") };
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, +sorted[Math.ceil(sorted.length * p / 100) - 1].toFixed(2)]));
}

async function join(api: ReturnType<typeof account>, user: { id: string }, roomId: string, index: number) {
  const room = new SynixirRoom({ roomId, userId: user.id, serverUrl: origin,
    getAccess: async ({ signal }) => {
      const { data } = await api(`/api/rooms/${roomId}/token`, "POST", undefined, signal);
      return { token: data.token, userId: data.user_id, role: data.role };
    } });
  const client = { room, api, user, roomId, index };
  clients.push(client);
  const now = performance.now();
  await room.connect();
  await until(() => room.state.saveStatus === "saved", "initial durable acknowledgement");
  connectMs.push(performance.now() - now);
  return client;
}

try {
  // Registration is outside the measured write phase. Each account keeps its own session and CSRF token.
  for (let index = 0; index < count; index++) {
    const api = account();
    await api("/api/session");
    const { user } = await api("/api/accounts", "POST", { username: `load_${index}`, password: "isolated load fixture password" });
    const group = groups[index % roomCount];
    const roomId = `load_room_${index % roomCount}`;
    if (!group.length) await api("/api/rooms", "POST", { room_id: roomId });
    else await group[0].api(`/api/rooms/${roomId}/members/${user.username}`, "PUT", { role: "editor" });
    group.push(await join(api, user, roomId, index));
  }

  for (const { room, index } of clients) room.awareness.setLocalStateField("load", index);
  await until(() => groups.every(group => group.every(({ room }) =>
    [...room.awareness.getStates().values()].filter(state => Number.isInteger(state.load)).length === group.length)), "awareness fanout");

  // Warm up each room before timing. Each writer owns a key, so convergence has an exact expectation.
  for (const { room, index } of clients) room.doc.getMap("load").set(`writer_${index}`, -1);
  await until(() => clients.every(({ room }) => room.state.saveStatus === "saved") &&
    groups.every(group => group.every(({ room }) => room.doc.getMap("load").size === group.length)), "warmup");
  const before = await metrics();
  for (const { room } of clients) room.doc.on("update", (update: { byteLength: number; }, source: string) => {
    if (source === "load") updateBytes += update.byteLength;
  });
  const phaseStarted = performance.now();
  await Promise.all(clients.map(async ({ room, index }) => {
    const peers = groups[index % roomCount];
    for (let iteration = 0; iteration < writes; iteration++) {
      const now = performance.now();
      room.doc.transact(() => room.doc.getMap("load").set(`writer_${index}`, iteration), "load");
      await until(() => room.state.saveStatus === "saved", "durable save");
      saveMs.push(performance.now() - now);
      await until(() => peers.every(peer => peer.room.doc.getMap("load").get(`writer_${index}`) === iteration), "convergence");
      convergeMs.push(performance.now() - now);
      // Closed-loop pacing avoids the intentional per-channel rate limiter in the default smoke run.
      await delay(25);
    }
  }));
  const phaseSeconds = (performance.now() - phaseStarted) / 1000;
  const after = await metrics();

  const first = clients[0];
  await first.room.disconnect();
  first.room.doc.getMap("load").set("offline", "retained draft");
  const reconnectStarted = performance.now();
  await first.room.connect();
  await until(() => first.room.state.saveStatus === "saved" && groups[0].every(({ room }) =>
    room.doc.getMap("load").get("offline") === "retained draft"), "offline edit after reconnect");
  const reconnectMs = performance.now() - reconnectStarted;
  // More than the single-message cap exercises chunk upload, fanout, and initial chunk download.
  const large = "x".repeat(1100000);
  first.room.doc.getMap("load").set("large", large);
  await until(() => first.room.state.saveStatus === "saved" && groups[0].every(({ room }) =>
    room.doc.getMap("load").get("large") === large), "chunked transfer");
  const observer = await join(first.api, first.user, first.roomId, count);
  assert.equal(observer.room.doc.getMap("load").get("large"), large);
  for (const writer of groups[0]) assert.equal(observer.room.doc.getMap("load").get(`writer_${writer.index}`), writes - 1);
  await Promise.all(clients.map(({ room }) => room.destroy()));
  assert.equal(process.listenerCount("exit"), exitListeners, "provider exit handlers released");
  let finalMetrics = await metrics();
  for (let attempt = 0; attempt < 50; attempt++) {
    finalMetrics = await metrics();
    if (finalMetrics.active_channels === 0) break;
    await delay(20);
  }
  assert.equal(finalMetrics.active_channels, 0, "all admission reservations released");
  const { text: beforeText, ...beforeStats } = before;
  const { text: afterText, ...afterStats } = after;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({
    recorded_at: new Date().toISOString(), mode: "closed-loop localhost smoke, 25ms pause per writer",
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      logical_cpus: os.availableParallelism(), database_pool_size: 10 },
    clients: count, rooms: roomCount, writes_per_client: writes,
    successful_writes: saveMs.length, rejected_writes: 0, generated_update_bytes: updateBytes,
    write_phase_seconds: +phaseSeconds.toFixed(3), writes_per_second: +(saveMs.length / phaseSeconds).toFixed(2),
    save_ms: percentiles(saveMs), convergence_ms: percentiles(convergeMs), connect_ms: percentiles(connectMs),
    reconnect_ms: +reconnectMs.toFixed(2), chunk_bytes: large.length,
    awareness_verified: true, offline_edit_verified: true, fresh_reader_verified: true, reservations_released: true,
    server_before: beforeStats, server_after: afterStats,
    generator_cpu_ms: { user: cpu.user / 1000, system: cpu.system / 1000 },
    total_seconds: +((performance.now() - started) / 1000).toFixed(3), metrics_text: finalMetrics.text,
  }));
} finally {
  await Promise.allSettled(clients.map(({ room }) => room.destroy()));
  process.setMaxListeners(listenerLimit);
}
