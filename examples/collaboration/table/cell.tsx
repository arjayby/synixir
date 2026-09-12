"use client";

import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { RenderCellProps, RenderEditCellProps } from "react-data-grid";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { TableSession } from "./session.ts";
import { cellKey, type AxisItem } from "./model.ts";

export const TableContext = createContext<TableSession | null>(null);
export const renderCell = (props: RenderCellProps<AxisItem>) => <CollaborativeCell {...props} />;
export const renderEditCell = (props: RenderEditCellProps<AxisItem>) => <CollaborativeCell {...props} active onClose={props.onClose} />;

type Props = Pick<RenderCellProps<AxisItem>, "row" | "column" | "rowIdx"> & { active?: boolean; onClose?: RenderEditCellProps<AxisItem>["onClose"] };

function CollaborativeCell({ row, column, rowIdx, active = false, onClose }: Props) {
  const session = useContext(TableContext)!;
  useSyncExternalStore(session.subscribe, session.snapshot);
  const host = useRef<HTMLDivElement>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const peers = session.peers(row.id, column.key);
  // Only the active cell and cells with a remote editor need CodeMirror. Passive
  // bindings draw Yjs carets/selections even when this tab never opened the cell.
  const showEditor = active || peers.some(peer => peer.hasCursor);
  const text = session.model.text(row.id, column.key);
  const value = text.toString();
  const address = session.address(row.id, column.key);
  const descriptionId = `table-people-${row.id}-${column.key}`;

  useLayoutEffect(() => {
    const cell = host.current!.closest<HTMLElement>("[role=gridcell]")!;
    cell.dataset.cell = cellKey(row.id, column.key);
    cell.dataset.row = row.id;
    cell.dataset.column = column.key;
    cell.setAttribute("aria-label", `${address}: ${session.columns.find(item => item.id === column.key)?.label || "Untitled"}, row ${rowIdx + 1}, ${value ? value.slice(0, 500) : "empty"}`);
    cell.setAttribute("aria-describedby", descriptionId);
    cell.setAttribute("aria-readonly", String(session.readOnly));
    cell.classList.toggle("has-collaborator", peers.length > 0);
    cell.style.setProperty("--peer-color", peers[0]?.color ?? "#3565b0");
    if (active) editor.current?.contentDOM.setAttribute("aria-label", `Edit ${address}`);
  });

  useLayoutEffect(() => {
    if (!showEditor) return;
    const permission = new Compartment();
    const isReadOnly = () => !active || session.readOnly;
    const finish = (focus = false) => close.current?.(false, focus);
    const view = new EditorView({ parent: editorHost.current!, doc: text.toString(), extensions: [
      permission.of(EditorState.readOnly.of(isReadOnly())),
      EditorView.editable.of(active),
      Prec.highest(keymap.of([
        { key: "Escape", run: () => { finish(true); return true; } },
        { key: "Enter", run: () => session.navigate(1, 0) },
        { key: "Shift-Enter", run: () => session.navigate(-1, 0) },
        { key: "Tab", run: () => session.navigate(0, 1, true) },
        { key: "Shift-Tab", run: () => session.navigate(0, -1, true) },
      ])),
      keymap.of([...yUndoManagerKeymap.map(binding => ({ ...binding, run: (view: EditorView) => isReadOnly() || (binding.run?.(view) ?? false) })), ...defaultKeymap]),
      drawSelection(), EditorView.lineWrapping, placeholder("Enter a value"),
      EditorView.contentAttributes.of(active ? { "aria-label": `Edit ${session.address(row.id, column.key)}`, spellcheck: "true" } : { "aria-hidden": "true", tabindex: "-1" }),
      Prec.highest(EditorView.domEventHandlers({ beforeinput: event => isReadOnly() && ["historyUndo", "historyRedo"].includes(event.inputType) })),
      yCollab(text, session.room.awareness, { undoManager: active ? session.model.history : false }),
    ] });
    editor.current = view;
    const reconfigure = () => view.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(isReadOnly())) });
    session.permissionListeners.add(reconfigure);
    if (active) {
      session.editing = true;
      session.active = true;
      session.closeEditor = finish;
      session.publish();
      view.focus();
      const initial = session.initialText;
      session.initialText = undefined;
      if (initial !== undefined && !session.readOnly) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial }, selection: { anchor: initial.length } });
    } else {
      // The binding draws awareness on updates, including already-present cursors.
      view.dispatch({});
    }
    return () => {
      session.permissionListeners.delete(reconfigure);
      view.destroy();
      editor.current = null;
      if (active) {
        session.closeEditor = undefined;
        session.editing = false;
        session.model.history.stopCapturing();
        session.room.awareness.setLocalStateField("cursor", null);
        session.publish();
      }
    };
  }, [session, text, showEditor, active, row.id, column.key]);

  return <div ref={host} className="table-cell-content">
    <span className="cell-display" hidden={showEditor}>{value}</span>
    <div ref={editorHost} className={active ? "table-cell-editor" : "table-cell-editor table-cell-preview"} hidden={!showEditor} />
    <span id={descriptionId} className="cell-people" hidden={!peers.length}>{peers.map(peer => `${peer.name} ${peer.editing ? "editing" : "viewing"}`).join(" · ")}</span>
  </div>;
}
