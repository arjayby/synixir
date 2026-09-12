"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { DataGrid, type CellKeyDownArgs, type CellKeyboardEvent, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { TableContext, renderCell, renderEditCell } from "./cell.tsx";
import { TableSession } from "./session.ts";
import { limits, type AxisItem } from "./model.ts";

const rowKeyGetter = (row: AxisItem) => row.id;
const rowNumber = ({ rowIdx }: { rowIdx: number }) => rowIdx + 1;

export function CollaborativeTable({ session }: { session: TableSession }) {
  useSyncExternalStore(session.subscribe, session.snapshot);
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const { rows, columns, readOnly, selection } = session;
  const selectedColumn = columns.find(column => column.id === selection?.column);
  const gridColumns = useMemo<Column<AxisItem>[]>(() => [
    { key: "row-number", name: "#", width: 48, frozen: true, cellClass: "table-row-number", renderCell: rowNumber },
    ...columns.map((column, index) => ({ key: column.id, name: `${String.fromCharCode(65 + index)} · ${column.label || "Untitled"}`, width: 205, minWidth: 120, maxWidth: 600, resizable: true, cellClass: "table-cell", renderCell, renderEditCell,
      // Editing streams into Y.Text. There is no whole-row commit callback.
      editorOptions: { closeOnExternalRowChange: false },
    })),
  ], [columns]);

  useLayoutEffect(() => {
    if (session.reposition) {
      session.reposition = false;
      session.grid?.setActivePosition(session.position(), { shouldFocus: false });
    }
    const undo = document.querySelector<HTMLButtonElement>("#undo")!;
    const redo = document.querySelector<HTMLButtonElement>("#redo")!;
    undo.disabled = readOnly || !session.model.history.canUndo();
    redo.disabled = readOnly || !session.model.history.canRedo();
  });
  useEffect(() => {
    const undo = document.querySelector<HTMLButtonElement>("#undo")!;
    const redo = document.querySelector<HTMLButtonElement>("#redo")!;
    const undoClick = () => session.history(), redoClick = () => session.history(true);
    const focus = () => { session.active = root.current!.contains(document.activeElement); session.publish(); };
    const visibility = () => { if (document.hidden) session.clearPresence(); };
    undo.addEventListener("click", undoClick); redo.addEventListener("click", redoClick);
    window.addEventListener("blur", session.clearPresence); window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      undo.removeEventListener("click", undoClick); redo.removeEventListener("click", redoClick);
      window.removeEventListener("blur", session.clearPresence); window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [session]);

  function add(axis: "rows" | "columns") {
    if (session.readOnly) return;
    session.closeEditor?.();
    const id = session.model.add(axis);
    session.refresh();
    if (!id) return;
    const row = axis === "rows" ? id : session.selection?.row ?? session.rows[0]?.id;
    const column = axis === "columns" ? id : session.selection?.column ?? session.columns[0]?.id;
    session.announcement = axis === "rows" ? "Row added." : "Column added.";
    if (row && column) {
      session.select({ row, column });
      // Wait for the grid to receive the added row/column before moving focus.
      requestAnimationFrame(() => {
        session.grid?.setActivePosition(session.position(), { shouldFocus: axis === "rows" });
        session.grid?.scrollToCell(session.position());
        if (axis === "columns") { nameInput.current?.focus(); nameInput.current?.select(); }
      });
    }
  }
  function remove(axis: "rows" | "columns") {
    if (session.readOnly || !session.selection) return;
    session.closeEditor?.();
    session.model.remove(axis, axis === "rows" ? session.selection.row : session.selection.column);
    session.refresh();
    session.announcement = `${axis === "rows" ? "Row" : "Column"} deleted. Undo restores its contents.`;
    session.notify();
  }
  function clear() {
    if (session.readOnly || !session.selection) return;
    session.closeEditor?.();
    session.model.clear(session.selection.row, session.selection.column);
  }
  function keyDown(args: CellKeyDownArgs<AxisItem>, event: CellKeyboardEvent) {
    if (args.mode === "EDIT") { event.preventGridDefault(); return; }
    if (!args.row || !args.column || args.column.key === "row-number" || event.nativeEvent.isComposing) return;
    // Focusing a cell programmatically should work like clicking it.
    if (!session.selection) session.select({ row: args.row.id, column: args.column.key });
    if (event.key === "Tab") {
      event.preventGridDefault();
      if (session.navigate(0, event.shiftKey ? -1 : 1, true)) event.preventDefault();
    } else if (["Enter", "F2"].includes(event.key)) {
      event.preventDefault(); event.preventGridDefault(); session.start();
    } else if (["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault(); event.preventGridDefault(); clear();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.preventGridDefault(); if (!session.readOnly) session.start(event.key);
    }
  }

  return <TableContext value={session}><div ref={root} className="table-app"
    onFocus={event => {
      if (event.target instanceof HTMLElement && event.target.matches("[data-cell]")) {
        const { row, column } = event.target.dataset;
        if (row && column) {
          session.select({ row, column });
          session.grid?.setActivePosition(session.position());
        }
      }
      session.active = true; session.publish();
    }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) session.clearPresence();
      if (event.target.closest(".table-cell-editor") && !event.relatedTarget?.closest(".table-cell-editor")) {
        queueMicrotask(() => { if (root.current && !document.activeElement?.closest(".table-cell-editor")) session.closeEditor?.(); });
      }
    }}
    onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest(".cm-editor") || event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); session.history(event.shiftKey || event.key.toLowerCase() === "y"); }
    }}
    onPasteCapture={event => {
      if (!session.selection || !(event.target instanceof Element) || !event.target.closest(".shared-table")) return;
      const value = event.clipboardData.getData("text/plain");
      if (session.editing && !/[\t\r\n]/.test(value) && !session.readOnly) return;
      event.preventDefault(); event.stopPropagation();
      if (session.readOnly) return;
      session.closeEditor?.(true);
      const { row, column } = session.selection;
      session.announcement = session.model.paste(row, column, value) ? "Pasted cells. Undo reverses this paste." : `Paste must fit within ${limits.rows} rows and ${limits.columns} columns, using at most ${limits.pasteCharacters} characters.`;
      session.refresh();
    }}
    onCopy={event => {
      if (session.editing || !session.selection || !(event.target instanceof Element) || !event.target.closest(".shared-table")) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", session.model.text(session.selection.row, session.selection.column).toString());
    }}>
    <div className="table-tools"><div>
      <Button id="add-row" onClick={() => add("rows")} disabled={readOnly || rows.length >= limits.rows}>+ Add row</Button>
      <Button id="add-column" variant="outline" onClick={() => add("columns")} disabled={readOnly || columns.length >= limits.columns}>+ Add column</Button>
    </div><span id="table-count" role="status">{rows.length} rows · {columns.length} columns</span></div>
    <div className="table-selection-bar"><output id="cell-address" aria-label="Selected cell">{selection ? session.address(selection.row, selection.column) : "Select a cell"}</output><span id="table-hint">Enter or double-click to edit · Drag a header edge to resize · Paste from a spreadsheet</span></div>
    <DataGrid ref={value => { session.grid = value; }} className="shared-table rdg-light" aria-label="Shared planning table" aria-describedby="table-hint"
      columns={gridColumns} rows={rows} rowKeyGetter={rowKeyGetter} rowHeight={68} headerRowHeight={46}
      style={{ height: Math.min(500, Math.max(256, 47 + rows.length * 68 + 16)) }}
      onActivePositionChange={({ row, column }) => session.select(row && column && column.key !== "row-number" ? { row: row.id, column: column.key } : null)}
      onCellKeyDown={keyDown}
    />
    {(!rows.length || !columns.length) && <Empty id="table-empty"><EmptyHeader><EmptyTitle>Your table is empty</EmptyTitle><EmptyDescription>Add a row and a column to start your table.</EmptyDescription></EmptyHeader></Empty>}
    <div className="table-bottom"><Button id="append-row" variant="outline" onClick={() => add("rows")} disabled={readOnly || rows.length >= limits.rows}>+ Add row</Button><p>Changes save as you go. Select any cell to see who’s there.</p></div>
    <section className="table-inspector" aria-label="Selected cell details">
      {!selectedColumn ? <p id="table-selection-empty">Select a cell to rename its column or remove a row.</p> : <div id="table-selection-fields">
        <FieldGroup className="column-name-field"><Field><FieldLabel htmlFor="column-name">Column name</FieldLabel><Input ref={nameInput} id="column-name" maxLength={80} value={selectedColumn.label ?? ""} readOnly={readOnly}
          onFocus={() => session.model.history.stopCapturing()} onBlur={() => session.model.history.stopCapturing()}
          onChange={event => { if (!session.readOnly) { session.model.rename(selectedColumn.id, event.target.value); session.refresh(); } }} /></Field></FieldGroup>
        <div className="table-cell-actions">
          <Button id="edit-cell" variant="outline" onClick={() => session.start()}>{readOnly ? "View cell" : "Edit cell"}</Button>
          <Button id="clear-cell" variant="outline" disabled={readOnly} onClick={clear}>Clear cell</Button>
          <Button id="delete-row" variant="destructive" disabled={readOnly} onClick={() => remove("rows")}>Delete row</Button>
          <Button id="delete-column" variant="destructive" disabled={readOnly} onClick={() => remove("columns")}>Delete column</Button>
        </div>
      </div>}
    </section>
    <p id="table-announcement" role="status" className="table-announcement">{session.announcement}</p>
  </div></TableContext>;
}
