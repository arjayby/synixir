import type { SynixirRoom } from "@synixir/client";
import type { DataGridHandle } from "react-data-grid";
import { createTableModel, type AxisItem } from "./model.ts";

export interface CellAddress { row: string; column: string }
export interface CellPeer { id: number; name: string; color: string; editing: boolean; hasCursor: boolean }

/** Shared state belongs to Yjs. This adapter owns only this tab's grid state. */
export class TableSession {
  readonly model;
  rows: AxisItem[];
  columns: AxisItem[];
  readOnly = true;
  selection: CellAddress | null = null;
  active = false;
  editing = false;
  announcement = "";
  initialText: string | undefined;
  reposition = false;
  grid: DataGridHandle | null = null;
  closeEditor: ((focus?: boolean) => void) | undefined;
  private revision = 0;
  private disposed = false;
  private frame: number | undefined;
  private readonly listeners = new Set<() => void>();
  readonly permissionListeners = new Set<() => void>();

  constructor(readonly room: SynixirRoom) {
    this.model = createTableModel(room.doc);
    this.rows = this.model.list("rows");
    this.columns = this.model.list("columns");
    room.doc.on("afterTransaction", this.schedule);
    room.awareness.on("change", this.schedule);
    for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const)
      this.model.history.on(event, this.schedule);
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  notify = () => {
    if (this.disposed) return;
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  private schedule = () => {
    if (!this.disposed && this.frame === undefined) this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.refresh();
    });
  };
  refresh() {
    const rows = this.model.list("rows"), columns = this.model.list("columns");
    const previous = this.position();
    if (JSON.stringify(rows) !== JSON.stringify(this.rows)) this.rows = rows;
    if (JSON.stringify(columns) !== JSON.stringify(this.columns)) this.columns = columns;
    if (this.selection) {
      const next = this.position();
      if (next.rowIdx < 0 || next.idx < 1) {
        this.closeEditor?.();
        this.selection = null;
        this.announcement = "The selected row or column was removed.";
        this.grid?.setActivePosition({ rowIdx: -1, idx: 0 }, { shouldFocus: true });
        this.publish();
      } else if (previous.rowIdx !== next.rowIdx || previous.idx !== next.idx) {
        // Selection follows the durable IDs when a preceding row/column disappears.
        this.closeEditor?.();
        this.reposition = true;
      }
    }
    this.notify();
  }
  position() {
    return { rowIdx: this.rows.findIndex(row => row.id === this.selection?.row), idx: this.columns.findIndex(column => column.id === this.selection?.column) + 1 };
  }
  address(row: string, column: string) {
    return `${String.fromCharCode(65 + this.columns.findIndex(item => item.id === column))}${this.rows.findIndex(item => item.id === row) + 1}`;
  }
  select(selection: CellAddress | null) {
    if (selection?.row !== this.selection?.row || selection?.column !== this.selection?.column) {
      this.model.history.stopCapturing();
      this.selection = selection;
      this.room.awareness.setLocalStateField("cursor", null);
    }
    this.active = true;
    this.publish();
    this.notify();
  }
  publish() {
    if (this.disposed) return;
    const value = this.active && this.selection ? { ...this.selection, action: this.editing && !this.readOnly ? "editing" : "viewing" } : null;
    if (JSON.stringify(this.room.awareness.getLocalState()?.collaborativeTable) !== JSON.stringify(value))
      this.room.awareness.setLocalStateField("collaborativeTable", value);
  }
  clearPresence = () => {
    this.active = false;
    this.room.awareness.setLocalStateField("cursor", null);
    this.publish();
  };
  peers(row: string, column: string): CellPeer[] {
    if (this.room.state.connection !== "connected") return [];
    const peers: CellPeer[] = [];
    for (const [id, state] of this.room.awareness.getStates()) {
      if (id === this.room.awareness.clientID || state.collaborativeTable?.row !== row || state.collaborativeTable?.column !== column) continue;
      peers.push({ id, name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest", color: /^#[0-9a-f]{6}$/i.test(state.user?.color) ? state.user.color : "#3565b0", editing: state.collaborativeTable.action === "editing", hasCursor: state.cursor?.anchor != null && state.cursor?.head != null });
    }
    return peers;
  }
  start(initial?: string) {
    if (!this.selection) return;
    this.initialText = this.readOnly ? undefined : initial;
    this.grid?.setActivePosition(this.position(), { enableEditor: true, shouldFocus: true });
  }
  navigate(dr: number, dc: number, wrap = false) {
    if (!this.selection) return false;
    let { rowIdx, idx } = this.position();
    if (wrap) {
      const offset = rowIdx * this.columns.length + idx - 1 + dc;
      if (offset < 0 || offset >= this.rows.length * this.columns.length) { this.closeEditor?.(true); return false; }
      rowIdx = Math.floor(offset / this.columns.length); idx = offset % this.columns.length + 1;
    } else {
      rowIdx = Math.max(0, Math.min(this.rows.length - 1, rowIdx + dr));
      idx = Math.max(1, Math.min(this.columns.length, idx + dc));
    }
    this.closeEditor?.(true);
    this.grid?.setActivePosition({ rowIdx, idx }, { shouldFocus: true });
    return true;
  }
  history = (redo = false) => {
    if (this.readOnly) return;
    this.closeEditor?.();
    redo ? this.model.history.redo() : this.model.history.undo();
    this.refresh();
  };
  setReadOnly(value: boolean) {
    if (this.readOnly !== value) {
      this.readOnly = value;
      // Reconfigure only when permission changes. Save notifications also call
      // this method from inside the CodeMirror update that produced the save.
      for (const listener of this.permissionListeners) listener();
      this.publish();
    }
    this.schedule();
  }
  destroy() {
    this.clearPresence();
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.room.doc.off("afterTransaction", this.schedule);
    this.room.awareness.off("change", this.schedule);
    this.model.destroy();
    this.listeners.clear();
    this.permissionListeners.clear();
  }
}
