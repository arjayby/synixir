import type { SynixirRoom } from "@synixir/client";
import { createBoardModel, columns, colors } from "./model.ts";
import { mountBoardView } from "./board-view.tsx";

export function createBoard(room: SynixirRoom) {
  const root = document.querySelector<HTMLElement>("#editor")!;
  const model = createBoardModel(room.doc);
  const events = new AbortController();
  const listen = <K extends keyof DocumentEventMap>(target: EventTarget, event: K, handler: (event: DocumentEventMap[K]) => void, capture = false) => target.addEventListener(event, handler as EventListener, { signal: events.signal, capture });
  let readOnly = true;
  let selectedId: string|null = null;
  let returnFocusId: string|null|undefined = null;
  let draggedId: string|null = null;
  let disposed = false;
  const undo = document.querySelector<HTMLButtonElement>("#undo")!;
  const redo = document.querySelector<HTMLButtonElement>("#redo")!;
  const announce = (text: string|null) => { document.querySelector<HTMLElement>("#board-announcement")!.textContent = text; };

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const board = element("div", "kanban-mount");
  const view = mountBoardView(board);

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
  const titleInput = dialog.querySelector<HTMLInputElement>("#card-title")!;
  const descriptionInput = dialog.querySelector<HTMLTextAreaElement>("#card-description")!;
  const columnInput = dialog.querySelector<HTMLSelectElement>("#card-column")!;
  const colorInput = dialog.querySelector<HTMLSelectElement>("#card-color")!;
  const deleteButton = dialog.querySelector<HTMLButtonElement>("#delete-card")!;
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
  function openCard(id: string|undefined) {
    if (!id || !model.cards.has(id)) return;
    selectedId = id ?? null;
    returnFocusId = id;
    model.history.stopCapturing();
    renderDialog();
    dialog.showModal();
    publish();
    renderPresence();
    titleInput.focus();
  }
  function endDrag(id?: string, column?: string, beforeId?: string | null) {
    if (!readOnly && id && column) {
      model.move(id, column, beforeId);
      announce(`Card moved to ${columns.find(item => item.id === column)?.label ?? column}.`);
    }
    draggedId = null;
    publish();
    render();
  }
  listen(dialog.querySelector<HTMLButtonElement>("#close-card")!, "click", () => dialog.close());
  listen(dialog, "close", () => {
    selectedId = null;
    model.history.stopCapturing();
    publish();
    const opener = [...root.querySelectorAll<HTMLElement>(".kanban-card")]
      .find(node => node.dataset.cardId === returnFocusId)?.querySelector<HTMLElement>(".card-open")!;
    const fallback = !undo.disabled ? undo : root.querySelector<HTMLElement>(".add-card:not(:disabled)")! ?? document.querySelector<HTMLButtonElement>("#connection")!;
    (opener ?? fallback).focus();
    returnFocusId = null;
  });
  for (const [input, field] of [[titleInput, "title"], [descriptionInput, "description"], [colorInput, "color"]] as const) {
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
  listen(dialog, "keydown", (event) => {
    if (readOnly || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) model.history.redo();
    else model.history.undo();
  });

  // Remote field replacements keep the caret near its original text. Edits to
  // separate fields merge; simultaneous edits to the same field are Y.Map LWW.
  function syncInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
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
      const translate = (position: number) => position <= prefix ? position : position >= before.length - suffix
        ? position + value.length - before.length : value.length - suffix;
      input.setSelectionRange(translate(start), translate(end ?? start));
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
    dialog.querySelector<HTMLElement>("#card-edit-help")!.textContent = readOnly ? "View only" : "Changes save as you type.";
  }
  function collaborators(id: string|undefined) {
    if (room.state.connection !== "connected") return [];
    return [...room.awareness.getStates()].filter(([client, state]) => client !== room.awareness.clientID && state.kanban?.cardId === id)
      .map(([, state]) => ({ name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest",
        action: ["editing", "moving"].includes(state.kanban.action) ? state.kanban.action : "viewing" }));
  }
  function renderPresence() {
    if (disposed) return;
    root.querySelectorAll<HTMLElement>(".kanban-card").forEach(node => {
      const people = collaborators(node.dataset.cardId);
      node.querySelector<HTMLElement>(".card-presence")!.textContent = people.map(person => `${person.name} ${person.action}`).join(" · ");
      node.classList.toggle("has-presence", people.length > 0);
    });
    dialog.querySelector<HTMLElement>("#card-collaborators")!.textContent = selectedId
      ? collaborators(selectedId).map(person => `${person.name} is ${person.action} this card`).join(" · ") : "";
  }
  function renderHistory() {
    undo.disabled = readOnly || !model.history.canUndo();
    redo.disabled = readOnly || !model.history.canRedo();
  }
  function render() {
    // dnd-kit owns the preview DOM until drop. Remote updates still apply to
    // the model immediately; endDrag renders the latest shared state.
    if (disposed || draggedId) return;
    view.render({
      cards: model.list(), readOnly, onOpen: openCard,
      onAdd: column => {
        if (readOnly) return;
        openCard(model.add(column));
        titleInput.select();
      },
      onDragStart: id => { draggedId = id; publish("moving", id); },
      onDragEnd: endDrag, onRender: renderPresence,
    });
    renderDialog();
    renderPresence();
    renderHistory();
  }
  model.cards.observeDeep(render);
  room.awareness.on("change", renderPresence);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const) model.history.on(event, renderHistory);
  render();

  function destroy() {
    disposed = true;
    events.abort();
    model.cards.unobserveDeep(render);
    room.awareness.off("change", renderPresence);
    view.cancel();
    view.destroy();
    model.destroy();
    publish("viewing", null);
    dialog.close();
    root.replaceChildren();
  }
  destroy.setReadOnly = (value: boolean) => {
    if (readOnly !== value) {
      readOnly = value;
      if (readOnly) view.cancel();
      render();
    }
    renderPresence();
  };
  return destroy;
}
