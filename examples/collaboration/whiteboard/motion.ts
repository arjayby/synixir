// Interpolate received positions over a little more than the 60 ms presence
// interval. New targets start from the position currently on screen, so packet
// timing never restarts a transition from an old network position.
import type { Point } from "../lib/canvas-data.ts";
interface MotionState { current: Point; target: Point; from: Point; moving: boolean; started: number }
export function createMotion({ onPaint = () => {} }: { onPaint?: (node: HTMLElement, point: Point) => void } = {}) {
  const positions = new Map<HTMLElement, MotionState>();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = 80;
  let frame: number|undefined;
  const paint = (node: HTMLElement, point: Point) => {
    node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    onPaint(node, point);
  };
  function tick(time: number) {
    frame = undefined;
    let pending = false;
    for (const [node, state] of positions) {
      if (!state.moving) continue;
      const progress = Math.min(1, Math.max(0, (time - state.started) / duration));
      state.current = { x: state.from.x + (state.target.x - state.from.x) * progress,
        y: state.from.y + (state.target.y - state.from.y) * progress };
      state.moving = progress < 1;
      paint(node, state.current);
      pending ||= state.moving;
    }
    if (pending) frame = requestAnimationFrame(tick);
  }
  function settle() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    for (const [node, state] of positions) {
      if (!state.moving) continue;
      state.current = state.target;
      state.moving = false;
      paint(node, state.current);
    }
  }
  function onVisibility() { if (document.hidden) settle(); }
  reducedMotion.addEventListener("change", settle);
  document.addEventListener("visibilitychange", onVisibility);
  return {
    move(node: HTMLElement, target: Point, smooth = true) {
      let state = positions.get(node);
      if (state && !state.moving && state.current.x === target.x && state.current.y === target.y) return;
      if (!state || !smooth || reducedMotion.matches || document.hidden) {
        state = { current: target, target, from: target, moving: false, started: 0 };
        positions.set(node, state);
        paint(node, target);
        return;
      }
      if (state.target.x === target.x && state.target.y === target.y) return;
      state.from = state.current;
      state.target = target;
      state.started = performance.now();
      state.moving = true;
      if (frame === undefined) frame = requestAnimationFrame(tick);
    },
    moving(node: HTMLElement) { return Boolean(positions.get(node)?.moving); },
    forget(node: HTMLElement) { positions.delete(node); },
    destroy() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      positions.clear();
      reducedMotion.removeEventListener("change", settle);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
