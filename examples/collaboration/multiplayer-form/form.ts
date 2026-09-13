import type { SynixirRoom } from "@synixir/client";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { createFormModel, textFields, requiredFields, validate } from "./model.ts";
import { createFormShell } from "./form-shell.tsx";
import { createBriefFormState, type FormFieldName } from "./form-state.ts";

export function createMultiplayerForm(room: SynixirRoom) {
  const root = document.querySelector<HTMLElement>("#editor")!;
  const model = createFormModel(room.doc);
  const briefForm = createBriefFormState(room.doc, model);
  const shell = createFormShell(root);
  const events = new AbortController();
  const on = <K extends keyof DocumentEventMap>(target: EventTarget, event: K, handler: (event: DocumentEventMap[K]) => void, capture = false) => target.addEventListener(event, handler as EventListener, { signal: events.signal, capture });
  const editors = new Map<string, { editor: EditorView; permission: Compartment }>();
  const fields = new Map<FormFieldName, {
    node: HTMLElement; title: HTMLElement; people: HTMLElement; control?: HTMLInputElement | HTMLSelectElement;
  }>();
  let readOnly = true;
  let activeField: string | null = null;
  let disposed = false;

  const form = root.querySelector<HTMLFormElement>("form")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  const undo = document.querySelector<HTMLButtonElement>("#undo")!;
  const redo = document.querySelector<HTMLButtonElement>("#redo")!;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-field]")) {
    const id = node.dataset.field as FormFieldName;
    fields.set(id, { node, title: root.querySelector<HTMLElement>(`#label-${id}`)!,
      people: root.querySelector<HTMLElement>(`#people-${id}`)!,
      control: node.querySelector<HTMLInputElement | HTMLSelectElement>("select, input[type=date]") ?? undefined,
    });
  }
  function publish() {
    room.awareness.setLocalStateField("multiplayerForm", activeField ? { field: activeField, action: readOnly ? "viewing" : "editing" } : null);
  }
  function activate(id: string) {
    if (activeField === id) return;
    model.history.stopCapturing();
    activeField = id;
    publish();
  }
  for (const spec of textFields) {
    const mount = root.querySelector<HTMLElement>(`#editor-${spec.id}`)!;
    const permission = new Compartment();
    const editor = new EditorView({
      parent: mount,
      doc: model.texts[spec.id].toString(),
      extensions: [
        permission.of(EditorState.readOnly.of(true)),
        keymap.of([...yUndoManagerKeymap.map(binding => ({ ...binding, run: (view: EditorView) => readOnly || (binding.run?.(view) ?? false) })), ...defaultKeymap]),
        drawSelection(), EditorView.lineWrapping, placeholder(spec.placeholder),
        EditorView.contentAttributes.of({ id: `field-${spec.id}`, "aria-labelledby": `label-${spec.id}`,
          "aria-describedby": `people-${spec.id} error-${spec.id}`, "aria-required": "true", spellcheck: "true" }),
        // Native history input events also bypass CodeMirror's read-only state.
        Prec.highest(EditorView.domEventHandlers({
          beforeinput: event => readOnly && ["historyUndo", "historyRedo"].includes(event.inputType),
          blur: () => { room.awareness.setLocalStateField("cursor", null); },
        })),
        yCollab(model.texts[spec.id], room.awareness, { undoManager: model.history }),
      ],
    });
    on(fields.get(spec.id)!.title, "click", () => editor.focus());
    editors.set(spec.id, { editor, permission });
  }
  for (const id of ["team", "priority", "date"] as const) {
    const control = fields.get(id)!.control!;
    on(control, "change", () => { if (!readOnly) model.set(id, control.value); });
  }
  const choices = root.querySelector<HTMLElement>(".channel-options")!;
  for (const checkbox of choices.querySelectorAll<HTMLInputElement>("input")) {
    on(checkbox, "change", () => { if (!readOnly) model.set(`channel:${checkbox.value}`, checkbox.checked); });
  }

  on(form, "focusin", (event) => {
    const id = (event.target as Element).closest<HTMLElement>("[data-field]")?.dataset.field;
    if (id) activate(id);
  });
  on(form, "focusout", (event) => {
    const id = (event.target as Element).closest<HTMLElement>("[data-field]")?.dataset.field;
    if (id && fields.has(id as FormFieldName)) briefForm.touch(id as FormFieldName);
    if ((event.relatedTarget as Element | null)?.closest<HTMLElement>("[data-field]")?.dataset.field !== activeField) {
      activeField = null;
      model.history.stopCapturing();
      publish();
    }
  });
  function clearPresence() {
    activeField = null;
    room.awareness.setLocalStateField("cursor", null);
    publish();
  }
  on(window, "blur", clearPresence);
  on(window, "focus", () => {
    const id = document.activeElement?.closest<HTMLElement>("[data-field]")?.dataset.field;
    if (id) activate(id);
  });
  on(document, "visibilitychange", () => { if (document.hidden) clearPresence(); });
  on(undo, "click", () => { if (!readOnly) model.history.undo(); });
  on(redo, "click", () => { if (!readOnly) model.history.redo(); });
  on(form, "keydown", (event) => {
    // Text editors handle these themselves, including cursor restoration.
    if ((event.target as Element).closest<HTMLElement>(".cm-editor") || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!["z", "y"].includes(key)) return;
    event.preventDefault();
    if (!readOnly) key === "y" || event.shiftKey ? model.history.redo() : model.history.undo();
  });
  const review = briefForm.control.handleSubmit(() => {
    if (disposed) return;
    root.querySelector<HTMLElement>("#brief-announcement")!.textContent = "";
    renderPreview(model.values());
    if (!dialog.open) dialog.showModal();
  }, errors => {
    if (disposed) return;
    const first = Object.keys(errors)[0];
    root.querySelector<HTMLElement>("#brief-announcement")!.textContent = "Complete the highlighted fields to review your brief.";
    if (first && editors.has(first)) editors.get(first)!.editor.focus();
    else if (first) fields.get(first as FormFieldName)?.control?.focus();
  });
  on(form, "submit", event => { event.preventDefault(); void review(); });
  on(root.querySelector<HTMLButtonElement>("#close-preview")!, "click", () => dialog.close());

  function renderPreview(values: import("./model.ts").FormValues) {
    const entries = [...textFields.map(spec => [spec.label, values[spec.id]]),
      ["Team", values.team], ["Priority", values.priority], ["Target date", values.date], ["Launch channels", values.channels.join(", ")]];
    root.querySelector<HTMLElement>("#preview-content")!.replaceChildren(...entries.flatMap(([label, value]) => [
      element("dt", "", label), element("dd", "", value || "Not set"),
    ]));
  }
  function renderHistory() {
    undo.disabled = readOnly || !model.history.canUndo();
    redo.disabled = readOnly || !model.history.canRedo();
  }
  function render() {
    if (disposed) return;
    const values = model.values();
    const errors = validate(values);
    for (const [id, { control }] of fields) {
      if (control) {
        if (control.value !== String(values[id] ?? "")) control.value = String(values[id] ?? "");
        control.disabled = readOnly;
      }
    }
    for (const checkbox of choices.querySelectorAll<HTMLInputElement>("input")) {
      checkbox.checked = values.channels.includes(checkbox.value);
      checkbox.disabled = readOnly;
    }
    const complete = requiredFields.filter(id => !errors[id]).length;
    root.querySelector<HTMLProgressElement>("#brief-progress")!.value = complete;
    root.querySelector<HTMLElement>("#brief-completion")!.textContent = `${complete} of ${requiredFields.length} complete`;
    if (dialog.open) renderPreview(values);
    renderHistory();
  }
  function renderPresence() {
    if (disposed) return;
    const peers = room.state.connection === "connected" ? [...room.awareness.getStates()]
      .filter(([id, state]) => id !== room.awareness.clientID && fields.has(state.multiplayerForm?.field)) : [];
    for (const [id, { node, people }] of fields) {
      const current = peers.filter(([, state]) => state.multiplayerForm.field === id);
      const label = current.map(([, state]) => `${typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest"} ${state.multiplayerForm.action === "editing" ? "editing" : "viewing"}`).join(" · ");
      if (people.textContent !== label) people.textContent = label;
      const color = current[0]?.[1].user?.color;
      node.style.setProperty("--peer-color", /^#[0-9a-f]{6}$/i.test(color) ? color : "#3565b0");
      node.classList.toggle("has-collaborator", current.length > 0);
    }
  }
  let reviewing = false;
  function renderValidation() {
    if (disposed) return;
    const errors: Record<string, string> = {};
    for (const [id, { control }] of fields) {
      const message = briefForm.control.getFieldState(id).error?.message;
      if (message) errors[id] = message;
      const target = control ?? editors.get(id)?.editor.contentDOM;
      target?.setAttribute("aria-invalid", String(Boolean(message)));
    }
    if (Object.keys(errors).length === 0) root.querySelector<HTMLElement>("#brief-announcement")!.textContent = "";
    shell.update({ errors, readOnly, reviewing });
  }
  const unsubscribeForm = briefForm.control.subscribe({
    formState: { errors: true, touchedFields: true, isValidating: true },
    callback: state => {
      reviewing = state.isValidating ?? reviewing;
      renderValidation();
    },
  });
  for (const text of Object.values(model.texts)) text.observe(render);
  model.properties.observe(render);
  room.awareness.on("change", renderPresence);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const) model.history.on(event, renderHistory);
  render();
  function destroy() {
    disposed = true;
    events.abort();
    for (const text of Object.values(model.texts)) text.unobserve(render);
    model.properties.unobserve(render);
    room.awareness.off("change", renderPresence);
    unsubscribeForm();
    briefForm.destroy();
    for (const { editor } of editors.values()) editor.destroy();
    model.destroy();
    clearPresence();
    dialog.close();
    shell.destroy();
  }
  destroy.setReadOnly = (value: boolean) => {
    if (value !== readOnly) {
      readOnly = value;
      for (const { editor, permission } of editors.values()) editor.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(value)) });
      publish();
      render();
      renderValidation();
    }
    renderPresence();
  };
  return destroy;
}
