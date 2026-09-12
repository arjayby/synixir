import { createBoardModel, columns, colors } from "./model.js";

export function createBoard(room) {
  const root = document.querySelector("#editor");
  document.querySelector("#open-peer").href = window.location.href;
  const model = createBoardModel(room.doc);
  const events = new AbortController();
  const listen = (target, event, fn) => target.addEventListener(event, fn, { signal: events.signal });
  let readOnly = true;
  let selectedId = null;
  let returnFocusId = null;
  let draggedId = null;
  let disposed = false;
  const nodes = new Map();
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  const announce = text => { document.querySelector("#board-announcement").textContent = text; };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const board = element("div", "kanban-board");
  for (const column of columns) {
    const section = element("section", `kanban-column column-${column.id}`);
    section.dataset.column = column.id;
    section.setAttribute("aria-label", column.label);
    const header = element("div", "column-heading");
    const title = element("h2", "", column.label);
    const count = element("span", "column-count", "0");
    const add = element("button", "add-card", "+ Add card");
    add.type = "button";
    add.setAttribute("aria-label", `Add card to ${column.label}`);
    add.disabled = true;
    const list = element("div", "card-list");
    header.append(title, count);
    section.append(header, list, add);
    board.append(section);
    nodes.set(column.id, { section, list, count, add });
    listen(add, "click", () => {
      if (readOnly) return;
      openCard(model.add(column.id));
      titleInput.select();
    });
    listen(section, "dragover", event => {
      if (readOnly || !draggedId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      section.classList.add("drop-target");
    });
    listen(section, "dragleave", event => {
      if (!section.contains(event.relatedTarget)) section.classList.remove("drop-target");
    });
    listen(section, "drop", event => {
      event.preventDefault();
      if (!readOnly && draggedId) {
        model.move(draggedId, column.id);
        announce(`Card moved to ${column.label}.`);
      }
      endDrag();
    });
  }

  const dialog = element("dialog", "card-dialog");
  dialog.setAttribute("aria-labelledby", "card-dialog-heading");
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="card-dialog-heading">Card details</h2><button type="button" class="subtle" id="close-card" aria-label="Close card">Close</button></div>
    <p id="card-collaborators" class="card-collaborators" aria-live="polite"></p>
    <label for="card-title">Title</label><input id="card-title" maxlength="160" autocomplete="off" />
    <label for="card-description">Description</label><textarea id="card-description" rows="6" maxlength="5000" placeholder="What needs to happen?"></textarea>
    <div class="card-properties"><div><label for="card-column">Status</label><select id="card-column"></select></div><div><label for="card-color">Color</label><select id="card-color"></select></div></div>
    <div class="dialog-footer"><span id="card-edit-help">Changes save as you type.</span><button type="button" id="delete-card" class="subtle danger">Delete card</button></div>`;
  root.replaceChildren(board, dialog);
  const titleInput = dialog.querySelector("#card-title");
  const descriptionInput = dialog.querySelector("#card-description");
  const columnInput = dialog.querySelector("#card-column");
  const colorInput = dialog.querySelector("#card-color");
  const deleteButton = dialog.querySelector("#delete-card");
  for (const column of columns) {
    const option = element("option", "", column.label);
    option.value = column.id;
    columnInput.append(option);
  }
  for (const color of colors) {
    const option = element("option", "", color[0].toUpperCase() + color.slice(1));
    option.value = color;
    colorInput.append(option);
  }

  function publish(action = "viewing", cardId = selectedId) {
    room.awareness.setLocalStateField("kanban", cardId ? { cardId, action } : null);
  }
  function openCard(id) {
    if (!id || !model.cards.has(id)) return;
    selectedId = id;
    returnFocusId = id;
    model.history.stopCapturing();
    renderDialog();
    dialog.showModal();
    publish();
    renderPresence();
    titleInput.focus();
  }
  function endDrag() {
    draggedId = null;
    nodes.forEach(({ section }) => section.classList.remove("drop-target"));
    publish();
    render();
  }
  listen(dialog.querySelector("#close-card"), "click", () => dialog.close());
  listen(dialog, "close", () => {
    selectedId = null;
    model.history.stopCapturing();
    publish();
    const opener = [...root.querySelectorAll(".kanban-card")]
      .find(node => node.dataset.cardId === returnFocusId)?.querySelector(".card-open");
    const fallback = !undo.disabled ? undo : root.querySelector(".add-card:not(:disabled)") ?? document.querySelector("#connection");
    (opener ?? fallback).focus();
    returnFocusId = null;
  });
  for (const [input, field] of [[titleInput, "title"], [descriptionInput, "description"], [colorInput, "color"]]) {
    listen(input, "focus", () => { model.history.stopCapturing(); publish(readOnly ? "viewing" : "editing"); });
    listen(input, "blur", () => { model.history.stopCapturing(); publish(); });
    listen(input, "input", () => {
      if (!readOnly && selectedId) model.edit(selectedId, field, input.value);
    });
  }
  listen(columnInput, "change", () => {
    if (!readOnly && selectedId) model.move(selectedId, columnInput.value);
  });
  listen(deleteButton, "click", () => {
    if (!readOnly && selectedId) {
      model.remove(selectedId);
      announce("Card deleted. Use Undo to restore it.");
    }
  });
  listen(undo, "click", () => { if (!readOnly) model.history.undo(); });
  listen(redo, "click", () => { if (!readOnly) model.history.redo(); });
  listen(dialog, "keydown", event => {
    if (readOnly || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) model.history.redo();
    else model.history.undo();
  });

  // Remote field replacements keep the caret near its original text. Edits to
  // separate fields merge; simultaneous edits to the same field are Y.Map LWW.
  function syncInput(input, value) {
    if (input.value === value) return;
    const before = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    let prefix = 0;
    let suffix = 0;
    while (prefix < before.length && prefix < value.length && before[prefix] === value[prefix]) prefix++;
    while (suffix < before.length - prefix && suffix < value.length - prefix &&
      before[before.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
    input.value = value;
    if (document.activeElement === input && start !== null) {
      const translate = position => position <= prefix ? position : position >= before.length - suffix
        ? position + value.length - before.length : value.length - suffix;
      input.setSelectionRange(translate(start), translate(end));
    }
  }
  function renderDialog() {
    if (!selectedId) return;
    const card = model.list().find(card => card.id === selectedId);
    if (!card) {
      dialog.close();
      selectedId = null;
      publish();
      announce("This card was removed.");
      return;
    }
    syncInput(titleInput, card.title);
    syncInput(descriptionInput, card.description);
    columnInput.value = card.placement.column;
    colorInput.value = card.color;
    titleInput.readOnly = descriptionInput.readOnly = readOnly;
    columnInput.disabled = colorInput.disabled = deleteButton.disabled = readOnly;
    dialog.querySelector("#card-edit-help").textContent = readOnly ? "View only" : "Changes save as you type.";
  }
  function collaborators(id) {
    if (room.state.connection !== "connected") return [];
    return [...room.awareness.getStates()].filter(([client, state]) => client !== room.awareness.clientID && state.kanban?.cardId === id)
      .map(([, state]) => ({ name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest",
        action: ["editing", "moving"].includes(state.kanban.action) ? state.kanban.action : "viewing" }));
  }
  function renderPresence() {
    if (disposed) return;
    root.querySelectorAll(".kanban-card").forEach(node => {
      const people = collaborators(node.dataset.cardId);
      node.querySelector(".card-presence").textContent = people.map(person => `${person.name} ${person.action}`).join(" · ");
      node.classList.toggle("has-presence", people.length > 0);
    });
    dialog.querySelector("#card-collaborators").textContent = selectedId
      ? collaborators(selectedId).map(person => `${person.name} is ${person.action} this card`).join(" · ") : "";
  }
  function renderHistory() {
    undo.disabled = readOnly || !model.history.canUndo();
    redo.disabled = readOnly || !model.history.canRedo();
  }
  function render() {
    // Keep the browser's dragged element mounted while remote changes arrive.
    // The model still syncs immediately; endDrag renders the latest state.
    if (disposed || draggedId) return;
    const focusedId = document.activeElement?.closest(".kanban-card")?.dataset.cardId;
    const cards = model.list();
    for (const column of columns) {
      const { list, count, add } = nodes.get(column.id);
      const items = cards.filter(card => card.placement.column === column.id);
      count.textContent = items.length;
      add.disabled = readOnly;
      list.replaceChildren(...items.map(card => {
        const node = element("article", `kanban-card card-${card.color}`);
        node.dataset.cardId = card.id;
        node.draggable = !readOnly;
        const open = element("button", "card-open");
        open.type = "button";
        open.setAttribute("aria-label", `Open card: ${card.title || "Untitled card"}`);
        open.append(element("span", "card-title", card.title || "Untitled card"));
        if (card.description) open.append(element("span", "card-description", card.description));
        open.append(element("span", "card-presence"));
        const grip = element("span", "card-grip", "⠿");
        grip.draggable = !readOnly;
        grip.hidden = readOnly;
        grip.title = "Drag card between columns";
        grip.setAttribute("aria-hidden", "true");
        node.append(open, grip);
        // These listeners belong to these short-lived nodes, not the root's
        // abort signal, which would retain detached cards on every update.
        open.addEventListener("click", () => openCard(card.id));
        node.addEventListener("dragstart", event => {
          if (readOnly) return event.preventDefault();
          draggedId = card.id;
          event.dataTransfer.setData("text/plain", card.id);
          event.dataTransfer.effectAllowed = "move";
          publish("moving", card.id);
        });
        node.addEventListener("dragend", endDrag);
        return node;
      }));
      if (!items.length) list.append(element("p", "column-empty", column.id === "done" ? "Finished work lands here." : "No cards yet."));
    }
    if (focusedId) {
      [...root.querySelectorAll(".kanban-card")].find(node => node.dataset.cardId === focusedId)?.querySelector("button").focus();
    }
    renderDialog();
    renderPresence();
    renderHistory();
  }
  model.cards.observeDeep(render);
  room.awareness.on("change", renderPresence);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"]) model.history.on(event, renderHistory);
  render();

  function destroy() {
    disposed = true;
    events.abort();
    model.cards.unobserveDeep(render);
    room.awareness.off("change", renderPresence);
    model.destroy();
    dialog.close();
    root.replaceChildren();
  }
  destroy.setReadOnly = value => {
    if (readOnly !== value) {
      readOnly = value;
      if (readOnly) endDrag();
      render();
    }
    renderPresence();
  };
  return destroy;
}
