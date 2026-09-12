import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { createTableModel, cellKey, limits } from "./model.js";

export function createCollaborativeTable(room) {
  const root = document.querySelector("#editor");
  document.querySelector("#open-peer").href = location.href;
  const model = createTableModel(room.doc);
  const events = new AbortController();
  const on = (node, event, handler, capture = false) => node.addEventListener(event, handler, { signal: events.signal, capture });
  const make = (tag, className = "", text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let readOnly = true, disposed = false, frame;
  let selection = null, editing = null, presenceActive = false;
  let rows = [], columns = [];
  const rowNodes = new Map(), headers = new Map(), cells = new Map();
  const undo = document.querySelector("#undo"), redo = document.querySelector("#redo");
  const announce = message => { root.querySelector("#table-announcement").textContent = message; };
  root.innerHTML = `
    <div class="table-tools"><div><button id="add-row" type="button" disabled>+ Add row</button><button id="add-column" type="button" class="subtle" disabled>+ Add column</button></div><span id="table-count" role="status"></span></div>
    <div class="table-selection-bar"><output id="cell-address" aria-label="Selected cell">Select a cell</output><span id="table-hint">Enter or double-click to edit · Paste from a spreadsheet</span></div>
    <div class="table-viewport" tabindex="-1"><table class="shared-table" role="grid" aria-label="Shared planning table" aria-describedby="table-hint"><thead><tr><th scope="col" class="row-number" aria-label="Row number">#</th></tr></thead><tbody></tbody></table></div>
    <div id="table-empty" hidden>Add a row and a column to start your table.</div>
    <div class="table-bottom"><button type="button" id="append-row" class="subtle" disabled>+ Add row</button><p>Changes save as you go. Select any cell to see who’s there.</p></div>
    <section class="table-inspector" aria-label="Selected cell details"><p id="table-selection-empty">Select a cell to rename its column or remove a row.</p><div id="table-selection-fields" hidden><div class="column-name-field"><label for="column-name">Column name</label><input id="column-name" maxlength="80" /></div><div class="table-cell-actions"><button type="button" id="edit-cell" class="subtle">Edit cell</button><button type="button" id="clear-cell" class="subtle">Clear cell</button><button type="button" id="delete-row" class="subtle">Delete row</button><button type="button" id="delete-column" class="subtle">Delete column</button></div></div></section>
    <p id="table-announcement" role="status" class="table-announcement"></p>`;
  const table = root.querySelector("table"), head = table.querySelector("thead tr"), body = table.querySelector("tbody");
  const nameInput = root.querySelector("#column-name");
  const addRow = root.querySelector("#add-row"), appendRow = root.querySelector("#append-row"), addColumn = root.querySelector("#add-column");
  const currentCell = () => selection && cells.get(cellKey(selection.row, selection.column));
  const address = (row, column) => `${String.fromCharCode(65 + columns.findIndex(item => item.id === column))}${rows.findIndex(item => item.id === row) + 1}`;
  function publish() {
    if (disposed) return;
    room.awareness.setLocalStateField("collaborativeTable", presenceActive && selection ? { ...selection, action: editing && !readOnly ? "editing" : "viewing" } : null);
  }
  function finishEditing(focus = false) {
    if (!editing) return;
    const previous = editing;
    editing = null;
    previous.view.destroy();
    previous.mount.remove();
    room.awareness.setLocalStateField("cursor", null);
    model.history.stopCapturing();
    const cell = currentCell();
    if (cell) {
      cell.display.hidden = false;
      cell.node.classList.remove("is-editing");
      cell.display.textContent = model.text(selection.row, selection.column).toString();
      if (focus) cell.node.focus();
    }
    publish();
  }
  function choose(row, column, focus = true) {
    if (selection?.row !== row || selection?.column !== column) {
      finishEditing();
      selection = { row, column };
      model.history.stopCapturing();
    }
    presenceActive = true;
    renderSelection();
    publish();
    if (focus) currentCell()?.node.focus({ preventScroll: true });
    if (focus) currentCell()?.node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function navigate(dr, dc, wrap = false) {
    if (!selection) return false;
    let r = rows.findIndex(item => item.id === selection.row), c = columns.findIndex(item => item.id === selection.column);
    if (wrap) {
      const index = r * columns.length + c + dc;
      if (index < 0 || index >= rows.length * columns.length) { finishEditing(); return false; }
      r = Math.floor(index / columns.length); c = index % columns.length;
    } else {
      r = Math.max(0, Math.min(rows.length - 1, r + dr)); c = Math.max(0, Math.min(columns.length - 1, c + dc));
    }
    finishEditing();
    choose(rows[r].id, columns[c].id);
    return true;
  }
  function beginEditing(initial) {
    if (!selection || !currentCell()) return;
    if (editing) { editing.view.focus(); return; }
    const cell = currentCell(), text = model.text(selection.row, selection.column);
    const mount = make("div", "table-cell-editor");
    cell.node.append(mount); cell.display.hidden = true; cell.node.classList.add("is-editing");
    const permission = new Compartment();
    const view = new EditorView({ parent: mount, doc: text.toString(), extensions: [
      permission.of(EditorState.readOnly.of(readOnly)),
      Prec.highest(keymap.of([
        { key: "Escape", run: () => { finishEditing(true); return true; } },
        { key: "Enter", run: () => navigate(1, 0) },
        { key: "Shift-Enter", run: () => navigate(-1, 0) },
        { key: "Tab", run: () => navigate(0, 1, true) },
        { key: "Shift-Tab", run: () => navigate(0, -1, true) },
      ])),
      keymap.of([...yUndoManagerKeymap.map(binding => ({ ...binding, run: editor => readOnly || binding.run(editor) })), ...defaultKeymap]),
      drawSelection(), EditorView.lineWrapping, placeholder("Enter a value"),
      EditorView.contentAttributes.of({ "aria-label": `Edit ${address(selection.row, selection.column)}`, spellcheck: "true" }),
      Prec.highest(EditorView.domEventHandlers({ beforeinput: event => readOnly && ["historyUndo", "historyRedo"].includes(event.inputType) })),
      yCollab(text, room.awareness, { undoManager: model.history }),
    ] });
    editing = { view, permission, mount };
    presenceActive = true; publish(); view.focus();
    if (initial !== undefined && !readOnly) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial }, selection: { anchor: initial.length } });
  }
  function add(axis) {
    if (readOnly) return;
    finishEditing();
    const id = model.add(axis);
    render();
    if (!id) { announce(`This example supports adding up to ${limits[axis]} ${axis}.`); return; }
    const row = axis === "rows" ? id : selection?.row ?? rows[0]?.id;
    const column = axis === "columns" ? id : selection?.column ?? columns[0]?.id;
    if (row && column) choose(row, column);
    if (axis === "columns" && column && row) { nameInput.focus(); nameInput.select(); }
    announce(axis === "rows" ? "Row added." : "Column added.");
  }
  on(addRow, "click", () => add("rows")); on(appendRow, "click", () => add("rows")); on(addColumn, "click", () => add("columns"));
  on(table, "focusin", event => {
    if (event.target.matches("[data-cell]")) choose(event.target.dataset.row, event.target.dataset.column, false);
  });
  on(table, "click", event => {
    if (event.target.closest(".cm-editor")) return;
    const cell = event.target.closest("[data-cell]");
    if (cell) { finishEditing(); choose(cell.dataset.row, cell.dataset.column); }
  });
  on(table, "dblclick", event => { if (event.target.closest("[data-cell]")) beginEditing(); });
  on(table, "keydown", event => {
    if (event.target.closest(".cm-editor") || !selection || event.isComposing) return;
    const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
    if (delta) { event.preventDefault(); navigate(...delta); }
    else if (event.key === "Tab") { if (navigate(0, event.shiftKey ? -1 : 1, true)) event.preventDefault(); }
    else if (["Enter", "F2"].includes(event.key)) { event.preventDefault(); beginEditing(); }
    else if (!readOnly && ["Backspace", "Delete"].includes(event.key)) { event.preventDefault(); model.clear(selection.row, selection.column); }
    else if (!readOnly && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); beginEditing(event.key); }
  });
  on(table, "copy", event => {
    if (editing || !selection || !event.clipboardData) return;
    event.preventDefault(); event.clipboardData.setData("text/plain", model.text(selection.row, selection.column).toString());
  });
  on(table, "paste", event => {
    if (!selection || !event.clipboardData) return;
    const value = event.clipboardData.getData("text/plain");
    if (editing && !/[\t\r\n]/.test(value)) return;
    event.preventDefault();
    if (readOnly) return;
    finishEditing(true);
    if (!model.paste(selection.row, selection.column, value)) announce(`Paste must fit within ${limits.rows} rows and ${limits.columns} columns, using at most ${limits.pasteCharacters} characters.`);
    else announce("Pasted cells. Undo reverses this paste.");
  }, true);
  on(nameInput, "focus", () => model.history.stopCapturing());
  on(nameInput, "blur", () => model.history.stopCapturing());
  on(nameInput, "input", () => { if (!readOnly && selection) model.rename(selection.column, nameInput.value); });
  on(root.querySelector("#edit-cell"), "click", () => beginEditing());
  on(root.querySelector("#clear-cell"), "click", () => { if (!readOnly && selection) { finishEditing(); model.clear(selection.row, selection.column); } });
  for (const axis of ["row", "column"]) on(root.querySelector(`#delete-${axis}`), "click", () => {
    if (!readOnly && selection) { finishEditing(); model.remove(`${axis}s`, selection[axis]); announce(`${axis === "row" ? "Row" : "Column"} deleted. Undo restores its contents.`); }
  });
  function history(redo = false) { if (!readOnly) { finishEditing(); redo ? model.history.redo() : model.history.undo(); } }
  on(undo, "click", () => history()); on(redo, "click", () => history(true));
  on(root, "keydown", event => {
    if (event.target.closest(".cm-editor") || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); history(event.shiftKey || event.key.toLowerCase() === "y"); }
  });
  on(root, "focusin", () => { presenceActive = true; publish(); });
  on(root, "focusout", event => {
    if (!root.contains(event.relatedTarget)) { presenceActive = false; room.awareness.setLocalStateField("cursor", null); publish(); }
    if (editing && !editing.mount.contains(event.relatedTarget)) {
      // Let pointer/keyboard handlers complete before removing the focused editor.
      queueMicrotask(() => { if (!disposed && editing && !editing.mount.contains(document.activeElement)) finishEditing(); });
    }
  });
  function clearPresence() { presenceActive = false; room.awareness.setLocalStateField("cursor", null); publish(); }
  on(window, "blur", clearPresence);
  on(window, "focus", () => { presenceActive = root.contains(document.activeElement); publish(); });
  on(document, "visibilitychange", () => { if (document.hidden) clearPresence(); });

  function renderHistory() { undo.disabled = readOnly || !model.history.canUndo(); redo.disabled = readOnly || !model.history.canRedo(); }
  function renderSelection() {
    for (const cell of cells.values()) {
      const selected = cell.node.dataset.row === selection?.row && cell.node.dataset.column === selection?.column;
      cell.node.classList.toggle("is-selected", selected); cell.node.setAttribute("aria-selected", String(selected));
      cell.node.tabIndex = selected || (!selection && cell.node.dataset.row === rows[0]?.id && cell.node.dataset.column === columns[0]?.id) ? 0 : -1;
    }
    if (editing && selection) editing.view.contentDOM.setAttribute("aria-label", `Edit ${address(selection.row, selection.column)}`);
    const column = columns.find(item => item.id === selection?.column);
    root.querySelector("#cell-address").textContent = selection ? address(selection.row, selection.column) : "Select a cell";
    root.querySelector("#table-selection-empty").hidden = Boolean(column);
    root.querySelector("#table-selection-fields").hidden = !column;
    if (column && nameInput.value !== column.label) nameInput.value = column.label;
    nameInput.readOnly = readOnly;
    for (const id of ["clear-cell", "delete-row", "delete-column"]) root.querySelector(`#${id}`).disabled = readOnly;
    root.querySelector("#edit-cell").textContent = readOnly ? "View cell" : "Edit cell";
  }
  function renderPresence() {
    if (disposed) return;
    const peers = room.state.connection === "connected" ? [...room.awareness.getStates()].filter(([id]) => id !== room.awareness.clientID) : [];
    const byCell = new Map();
    for (const [, state] of peers) {
      const cell = state.collaborativeTable;
      if (!cell || typeof cell.row !== "string" || typeof cell.column !== "string") continue;
      const key = cellKey(cell.row, cell.column);
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push({ name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest", action: cell.action === "editing" ? "editing" : "viewing", color: /^#[0-9a-f]{6}$/i.test(state.user?.color) ? state.user.color : "#3565b0" });
    }
    for (const [key, cell] of cells) {
      const current = byCell.get(key) ?? [];
      const title = current.map(peer => `${peer.name} ${peer.action}`).join(" · ");
      if (cell.people.textContent !== title) cell.people.textContent = title;
      cell.people.hidden = !current.length;
      cell.node.classList.toggle("has-collaborator", current.length > 0);
      cell.node.style.setProperty("--peer-color", current[0]?.color ?? "#3565b0");
    }
  }
  // Move only out-of-order elements. Replacing a row would discard a teammate's
  // caret and interrupt the local editor on every document update.
  function order(parent, children) { children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null); }); }
  function render() {
    if (disposed) return;
    rows = model.list("rows"); columns = model.list("columns");
    if (selection && (!rows.some(row => row.id === selection.row) || !columns.some(column => column.id === selection.column))) {
      finishEditing(); selection = null; publish();
      root.querySelector(".table-viewport").focus(); announce("The selected row or column was removed.");
    }
    const rowIds = new Set(rows.map(row => row.id)), columnIds = new Set(columns.map(column => column.id));
    for (const [key, cell] of cells) if (!rowIds.has(cell.node.dataset.row) || !columnIds.has(cell.node.dataset.column)) { cell.node.remove(); cells.delete(key); }
    for (const [id, tr] of rowNodes) if (!rowIds.has(id)) { tr.remove(); rowNodes.delete(id); }
    for (const [id, th] of headers) if (!columnIds.has(id)) { th.remove(); headers.delete(id); }
    for (const [index, column] of columns.entries()) {
      if (!headers.has(column.id)) { const th = make("th"); th.scope = "col"; headers.set(column.id, th); }
      const th = headers.get(column.id); th.textContent = `${String.fromCharCode(65 + index)}  ·  ${column.label || "Untitled"}`;
    }
    order(head, [head.firstElementChild, ...columns.map(column => headers.get(column.id))]);
    for (const [index, row] of rows.entries()) {
      if (!rowNodes.has(row.id)) {
        const tr = make("tr"), number = make("th", "row-number"); number.scope = "row"; tr.append(number); rowNodes.set(row.id, tr);
      }
      const tr = rowNodes.get(row.id); tr.firstChild.textContent = String(index + 1);
      for (const column of columns) {
        const key = cellKey(row.id, column.id);
        if (!cells.has(key)) {
          const node = make("td", "table-cell"), display = make("span", "cell-display"), people = make("span", "cell-people");
          node.dataset.cell = key; node.dataset.row = row.id; node.dataset.column = column.id;
          people.id = `table-people-${crypto.randomUUID()}`;
          node.setAttribute("aria-describedby", people.id);
          node.setAttribute("role", "gridcell"); node.append(display, people); cells.set(key, { node, display, people });
        }
        const cell = cells.get(key), value = model.text(row.id, column.id).toString();
        cell.node.setAttribute("aria-label", `${address(row.id, column.id)}: ${column.label || "Untitled"}, row ${index + 1}, ${value ? value.slice(0, 500) : "empty"}`);
        if (cell.display.textContent !== value) cell.display.textContent = value;
        cell.node.classList.toggle("is-empty", !value);
      }
      order(tr, [tr.firstElementChild, ...columns.map(column => cells.get(cellKey(row.id, column.id)).node)]);
    }
    order(body, rows.map(row => rowNodes.get(row.id)));
    table.setAttribute("aria-rowcount", String(rows.length + 1)); table.setAttribute("aria-colcount", String(columns.length + 1));
    root.querySelector("#table-count").textContent = `${rows.length} rows · ${columns.length} columns`;
    root.querySelector("#table-empty").hidden = Boolean(rows.length && columns.length);
    addRow.disabled = appendRow.disabled = readOnly || rows.length >= limits.rows;
    addColumn.disabled = readOnly || columns.length >= limits.columns;
    renderSelection(); renderPresence(); renderHistory();
  }
  function scheduleRender() { if (!disposed && frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; render(); }); }
  room.doc.on("afterTransaction", scheduleRender);
  room.awareness.on("change", renderPresence);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"]) model.history.on(event, renderHistory);
  render();
  function destroy() {
    disposed = true; cancelAnimationFrame(frame); events.abort();
    room.doc.off("afterTransaction", scheduleRender); room.awareness.off("change", renderPresence);
    finishEditing(); room.awareness.setLocalStateField("collaborativeTable", null);
    model.destroy(); cells.clear(); rowNodes.clear(); headers.clear(); root.replaceChildren();
  }
  destroy.setReadOnly = value => {
    if (readOnly !== value) {
      readOnly = value;
      if (editing) editing.view.dispatch({ effects: editing.permission.reconfigure(EditorState.readOnly.of(value)) });
      publish(); render();
    }
    renderPresence();
  };
  return destroy;
}
