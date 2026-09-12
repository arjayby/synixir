// Attach arrows to the side facing the other node. Control points keep the
// arrow perpendicular to the boundary, including the tips of decision nodes.
export function connectionPath(source: Pick<import("../lib/canvas-data.ts").CanvasItem, "position" | "size">, target: Pick<import("../lib/canvas-data.ts").CanvasItem, "position" | "size">, { reciprocal = false, targetGap = 0 } = {}) {
  const a = { x: source.position.x + source.size.width / 2, y: source.position.y + source.size.height / 2 };
  const b = { x: target.position.x + target.size.width / 2, y: target.position.y + target.size.height / 2 };
  const horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
  const axis = horizontal ? 'x' : 'y';
  const sign = b[axis] >= a[axis] ? 1 : -1;
  a[axis] += sign * (horizontal ? source.size.width : source.size.height) / 2;
  // Leave room for a visible arrowhead beside a connection handle.
  b[axis] -= sign * ((horizontal ? target.size.width : target.size.height) / 2 + targetGap);
  const bend = Math.max(45, Math.abs(b[axis] - a[axis]) / 2);
  const c = { ...a, [axis]: a[axis] + sign * bend };
  const d = { ...b, [axis]: b[axis] - sign * bend };
  if (reciprocal) {
    // Opposite directions take opposite curves instead of hiding each other.
    const cross = horizontal ? "y" : "x";
    c[cross] += sign * 60;
    d[cross] += sign * 60;
  }
  return { path: `M ${a.x} ${a.y} C ${c.x} ${c.y}, ${d.x} ${d.y}, ${b.x} ${b.y}`,
    label: { x: (a.x + 3 * c.x + 3 * d.x + b.x) / 8, y: (a.y + 3 * c.y + 3 * d.y + b.y) / 8 } };
}
