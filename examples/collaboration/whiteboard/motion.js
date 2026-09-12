// Interpolate received positions over a little more than the 60 ms presence
// interval. New targets start from the position currently on screen, so packet
// timing never restarts a transition from an old network position.
export function createMotion({ onPaint = () => {} } = {}) {
  const positions = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = 80;
  let frame;
  const paint = (node, point) => {
    node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    onPaint(node, point);
  };
  function tick(time) {
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
    cancelAnimationFrame(frame);
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
    move(node, target, smooth = true) {
      let state = positions.get(node);
      if (state && !state.moving && state.current.x === target.x && state.current.y === target.y) return;
      if (!state || !smooth || reducedMotion.matches || document.hidden) {
        state = { current: target, target, moving: false };
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
    moving(node) { return Boolean(positions.get(node)?.moving); },
    forget(node) { positions.delete(node); },
    destroy() {
      cancelAnimationFrame(frame);
      positions.clear();
      reducedMotion.removeEventListener("change", settle);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
