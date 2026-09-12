import type { SynixirRoom } from "@synixir/client";
import type { Point } from "../lib/canvas-data.ts";
import type { FlowchartAdapter } from "./adapter.ts";
import { canvasSize } from "./model.ts";
import { createCursorMotion } from "../lib/cursor-motion.ts";

export interface FlowPeer { id: number; name: string; color: string; selectedId: string | null; cursor: Point | null; drag: (Point & { id: string }) | null }
function validPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object" || !("x" in value) || !("y" in value)) return false;
  return typeof value.x === "number" && typeof value.y === "number" && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    value.x >= 0 && value.y >= 0 && value.x <= canvasSize.width && value.y <= canvasSize.height;
}

export function createFlowchartPresence(room: SynixirRoom, adapter: FlowchartAdapter) {
  let peers: FlowPeer[] = [];
  let targets: FlowPeer[] = [];
  let cursor: Point | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let lastPublished = -Infinity;
  let queued = "", published = "";
  const listeners = new Set<() => void>();
  const cursorMotion = createCursorMotion<number>(paintCursors);
  function paintCursors() {
    peers = targets.map(peer => ({ ...peer, cursor: cursorMotion.get(peer.id) ?? null }));
    for (const listener of listeners) listener();
  }
  const motion = new Map<string, { from: Point; current: Point; target: Point; start: number }>();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const localState = () => {
    const state = adapter.getSnapshot(), gesture = adapter.preview();
    return { cursor, selectedId: state.selectedId, drag: !state.readOnly && gesture?.kind === "drag" ? { id: gesture.id, ...gesture.current.position } : null };
  };
  function publish() {
    clearTimeout(timer); timer = undefined;
    if (disposed) return;
    published = JSON.stringify(localState());
    lastPublished = performance.now();
    room.awareness.setLocalStateField("flowchart", JSON.parse(published));
  }
  function schedulePublish() {
    const next = JSON.stringify(localState());
    if (next === queued && next === published) return;
    queued = next;
    if (timer !== undefined) return;
    const delay = 60 - (performance.now() - lastPublished);
    if (delay <= 0) publish(); else timer = setTimeout(publish, delay);
  }
  function tick(time: number) {
    frame = undefined;
    let moving = false;
    const positions = new Map<string, Point>();
    for (const [id, state] of motion) {
      const progress = reduced.matches || document.hidden ? 1 : Math.min(1, Math.max(0, (time - state.start) / 80));
      state.current = { x: state.from.x + (state.target.x - state.from.x) * progress, y: state.from.y + (state.target.y - state.from.y) * progress };
      positions.set(id, state.current);
      moving ||= progress < 1;
    }
    adapter.setRemotePositions(positions);
    if (moving) frame = requestAnimationFrame(tick);
  }
  function readPeers() {
    if (disposed) return;
    targets = room.state.connection === "connected" ? [...room.awareness.getStates()]
      .filter(([id, state]) => id !== room.awareness.clientID && state.flowchart && typeof state.flowchart === "object")
      .sort(([a], [b]) => a - b).map(([id, state]) => {
        const flow = state.flowchart;
        return { id, name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest",
          color: typeof state.user?.color === "string" && /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : "#3565b0",
          selectedId: typeof flow.selectedId === "string" ? flow.selectedId : null,
          cursor: validPoint(flow.cursor) ? flow.cursor : null,
          drag: validPoint(flow.drag) && "id" in flow.drag && typeof flow.drag.id === "string" ? flow.drag as Point & { id: string } : null };
      }) : [];
    cursorMotion.update(new Map(targets.flatMap(peer => peer.cursor ? [[peer.id, peer.cursor] as const] : [])));
    const items = adapter.getSnapshot().items;
    const dragTargets = new Map<string, Point>();
    for (const peer of targets) if (peer.drag) {
      const item = items.find(item => item.id === peer.drag!.id);
      if (item) dragTargets.set(item.id, adapter.model.boundedPosition(peer.drag, item.size));
    }
    let changed = false;
    for (const id of motion.keys()) if (!dragTargets.has(id)) { motion.delete(id); changed = true; }
    for (const [id, target] of dragTargets) {
      const previous = motion.get(id);
      if (previous?.target.x === target.x && previous.target.y === target.y) continue;
      const from = previous?.current ?? items.find(item => item.id === id)!.position;
      motion.set(id, { from, current: from, target, start: performance.now() }); changed = true;
    }
    if (changed && frame === undefined) frame = requestAnimationFrame(tick);
    paintCursors();
  }
  const unsubscribeGraph = adapter.subscribe(schedulePublish);
  room.awareness.on("change", readPeers);
  const unsubscribeRoom = room.subscribe(readPeers);
  const settle = () => { if (frame !== undefined) cancelAnimationFrame(frame); tick(Infinity); };
  reduced.addEventListener("change", settle);
  document.addEventListener("visibilitychange", settle);
  schedulePublish();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => peers,
    setCursor(point: Point | null) { cursor = validPoint(point) ? point : null; schedulePublish(); },
    destroy() {
      disposed = true; clearTimeout(timer); if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribeGraph(); unsubscribeRoom(); room.awareness.off("change", readPeers);
      reduced.removeEventListener("change", settle); document.removeEventListener("visibilitychange", settle);
      cursorMotion.destroy(); listeners.clear(); motion.clear(); room.awareness.setLocalStateField("flowchart", null);
    },
  };
}
export type FlowchartPresence = ReturnType<typeof createFlowchartPresence>;
