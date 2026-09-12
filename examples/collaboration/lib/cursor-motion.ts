import type { Point } from "./canvas-data.ts";

type Motion = { from: Point; current: Point; target: Point; started: number; moving: boolean };

// Render between awareness packets without increasing network traffic. Only
// cursor presentation changes here; document state and local input stay direct.
export function createCursorMotion<Key>(onFrame: () => void) {
  const positions = new Map<Key, Motion>();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = 60;
  let frame: number | undefined;
  let disposed = false;

  function tick(time: number) {
    frame = undefined;
    let moving = false;
    for (const state of positions.values()) {
      if (!state.moving) continue;
      const progress = Math.min(1, Math.max(0, (time - state.started) / duration));
      state.current = {
        x: state.from.x + (state.target.x - state.from.x) * progress,
        y: state.from.y + (state.target.y - state.from.y) * progress,
      };
      state.moving = progress < 1;
      moving ||= state.moving;
    }
    onFrame();
    if (moving) frame = requestAnimationFrame(tick);
  }
  function settle() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    let changed = false;
    for (const state of positions.values()) {
      changed ||= state.moving;
      state.current = state.target;
      state.moving = false;
    }
    if (changed) onFrame();
  }
  const visibility = () => { if (document.hidden) settle(); };
  reduced.addEventListener("change", settle);
  document.addEventListener("visibilitychange", visibility);

  return {
    get: (key: Key) => positions.get(key)?.current,
    update(targets: ReadonlyMap<Key, Point>) {
      if (disposed) return;
      for (const key of positions.keys()) if (!targets.has(key)) positions.delete(key);
      for (const [key, point] of targets) {
        const state = positions.get(key);
        if (state?.target.x === point.x && state.target.y === point.y) continue;
        const target = { ...point };
        const smooth = state && !reduced.matches && !document.hidden;
        const from = smooth ? state.current : target;
        positions.set(key, { from, current: from, target, started: performance.now(), moving: Boolean(smooth) });
      }
      if ([...positions.values()].some(state => state.moving)) {
        if (frame === undefined) frame = requestAnimationFrame(tick);
      } else if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
    },
    destroy() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      positions.clear();
      reduced.removeEventListener("change", settle);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
