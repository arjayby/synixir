import * as Y from "yjs";

export const limits = { rows: 100, columns: 12, pasteCharacters: 50000 };
export interface AxisItem { id: string; order: number; label?: string }
type Axis = "rows" | "columns";
const initialRows = ["row-1", "row-2", "row-3"].map((id, order) => ({ id, order }));
const initialColumns = ["Task", "Owner", "Status", "Due date"].map((label, order) => ({ id: `column-${order + 1}`, order, label }));
export const cellKey = (row: string, column: string) => JSON.stringify([row, column]);

export function createTableModel(doc: Y.Doc) {
  const rows = doc.getMap<number>("collaborative-table:rows:v1");
  const columns = doc.getMap<number>("collaborative-table:columns:v1");
  const deleted = doc.getMap<boolean>("collaborative-table:deleted:v1");
  const labels = doc.getMap<string>("collaborative-table:labels:v1");
  const origin = {};
  const history = new Y.UndoManager([rows, columns, deleted, labels], { trackedOrigins: new Set([origin]) });
  const texts = new Map<string, Y.Text>();
  function list(axis: Axis): AxisItem[] {
    const defaults: AxisItem[] = axis === "rows" ? initialRows : initialColumns;
    const extra = axis === "rows" ? rows : columns;
    return [...defaults, ...[...extra].filter(([id, order]) => typeof id === "string" && Number.isFinite(order) && !defaults.some(item => item.id === id))
      .map(([id, order]): AxisItem => ({ id, order }))]
      .filter(item => !deleted.get(`${axis}:${item.id}`))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(item => axis === "rows" ? item : { ...item, label: String(labels.get(item.id) ?? item.label ?? "Column").slice(0, 80) });
  }
  function text(row: string, column: string) {
    const key = cellKey(row, column);
    if (!texts.has(key)) {
      // Stable top-level names let two clients edit an untouched cell without
      // racing to initialize a nested Y.Text and discarding one client's text.
      const value = doc.getText(`collaborative-table:cell:${key}:v1`);
      texts.set(key, value);
      history.addToScope(value);
    }
    return texts.get(key)!;
  }
  function action<T>(fn: () => T): T {
    history.stopCapturing();
    let result!: T;
    doc.transact(() => { result = fn(); }, origin);
    history.stopCapturing();
    return result;
  }
  function append(axis: Axis) {
    const items = list(axis);
    if (items.length >= limits[axis]) return null;
    const id = crypto.randomUUID();
    (axis === "rows" ? rows : columns).set(id, Math.max(-1, ...items.map(item => item.order)) + 1);
    if (axis === "columns") labels.set(id, `Column ${items.length + 1}`);
    return id;
  }
  function setCell(row: string, column: string, value: string) {
    const cell = text(row, column);
    if (cell.toString() === value) return;
    cell.delete(0, cell.length);
    cell.insert(0, value);
  }
  return {
    history, list, text,
    add(axis: string) { if (axis !== "rows" && axis !== "columns") return null; return action(() => append(axis)); },
    rename(id: string, value: unknown) {
      if (typeof value !== "string" || !list("columns").some(item => item.id === id)) return;
      if (labels.get(id) !== value) doc.transact(() => labels.set(id, value.slice(0, 80)), origin);
    },
    remove(axis: string, id: string) {
      if ((axis !== "rows" && axis !== "columns") || !list(axis).some(item => item.id === id)) return;
      // Retain cell contents so undo can restore a deleted row or column,
      // including edits made concurrently by a disconnected collaborator.
      action(() => deleted.set(`${axis}:${id}`, true));
    },
    clear(row: string, column: string) {
      if (list("rows").some(item => item.id === row) && list("columns").some(item => item.id === column))
        action(() => setCell(row, column, ""));
    },
    paste(row: string, column: string, value: string) {
      if (typeof value !== "string" || value.length > limits.pasteCharacters) return false;
      const matrix = value.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map(line => line.split("\t"));
      const rowIndex = list("rows").findIndex(item => item.id === row);
      const columnIndex = list("columns").findIndex(item => item.id === column);
      const width = Math.max(...matrix.map(line => line.length));
      if (rowIndex < 0 || columnIndex < 0 || rowIndex + matrix.length > limits.rows || columnIndex + width > limits.columns) return false;
      action(() => {
        while (list("rows").length < rowIndex + matrix.length) append("rows");
        while (list("columns").length < columnIndex + width) append("columns");
        const targetRows = list("rows"), targetColumns = list("columns");
        matrix.forEach((line, r) => line.forEach((value, c) => setCell(targetRows[rowIndex + r].id, targetColumns[columnIndex + c].id, value)));
      });
      return true;
    },
    destroy() { history.destroy(); texts.clear(); },
  };
}
