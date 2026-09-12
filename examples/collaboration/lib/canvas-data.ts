import * as Y from "yjs";
export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface CanvasItem {
  id: string;
  kind: string;
  text: string;
  color: string;
  position: Point;
  size: Size;
  order: number;
}
export function canvasItem(
  id: string,
  value: unknown,
  kinds: string[],
  colors: string[],
): CanvasItem | undefined {
  if (!(value instanceof Y.Map)) return;
  const kind: unknown = value.get("kind"),
    order: unknown = value.get("order");
  const position: unknown = value.get("position"),
    size: unknown = value.get("size");
  if (
    typeof kind !== "string" ||
    !kinds.includes(kind) ||
    typeof order !== "number" ||
    !Number.isFinite(order)
  )
    return;
  if (
    !position ||
    typeof position !== "object" ||
    !("x" in position) ||
    !("y" in position) ||
    typeof position.x !== "number" ||
    typeof position.y !== "number" ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  )
    return;
  if (
    !size ||
    typeof size !== "object" ||
    !("width" in size) ||
    !("height" in size) ||
    typeof size.width !== "number" ||
    typeof size.height !== "number" ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width < 80 ||
    size.width > 600 ||
    size.height < 60 ||
    size.height > 500
  )
    return;
  const color: unknown = value.get("color");
  return {
    id,
    kind,
    order,
    text: String(value.get("text") ?? ""),
    color: typeof color === "string" && colors.includes(color) ? color : "yellow",
    position: { x: position.x, y: position.y },
    size: { width: size.width, height: size.height },
  };
}
