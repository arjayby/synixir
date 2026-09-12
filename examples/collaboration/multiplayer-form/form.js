import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { createFormModel, textFields, teams, priorities, channels, requiredFields, validate } from "./model.js";

export function createMultiplayerForm(room) {
  const root = document.querySelector("#editor");
  document.querySelector("#open-peer").href = window.location.href;
  const model = createFormModel(room.doc);
  const events = new AbortController();
  const on = (node, event, handler) => node.addEventListener(event, handler, { signal: events.signal });
  const editors = new Map();
  const fields = new Map();
  const touched = new Set();
  let readOnly = true;
  let activeField = null;
  let disposed = false;

  root.innerHTML = `
    <form class="shared-form" novalidate>
      <div class="brief-heading"><div><p class="eyebrow">PROJECT BRIEF</p><h2>Let’s get on the same page.</h2><p class="note">A shared starting point for your next project.</p></div><span id="brief-completion">0 of 4 complete</span></div>
      <progress id="brief-progress" value="0" max="4" aria-label="Required fields completed"></progress>
      <section class="brief-section" aria-labelledby="basics-heading"><h3 id="basics-heading"><span>01</span> The idea</h3><div id="text-fields"></div></section>
      <section class="brief-section" aria-labelledby="details-heading"><h3 id="details-heading"><span>02</span> The details</h3><div class="brief-grid" id="detail-fields"></div></section>
      <section class="brief-section" aria-labelledby="channels-heading"><h3 id="channels-heading"><span>03</span> Where it will live</h3><div id="channel-field"></div></section>
      <div class="brief-actions"><p class="note">Changes save as you go. Review a live preview when you’re ready.</p><button type="submit">Review brief</button></div>
      <p id="brief-announcement" role="status"></p>
    </form>
    <dialog class="brief-preview" aria-labelledby="preview-title"><div class="preview-heading"><div><p class="eyebrow">LIVE PREVIEW</p><h2 id="preview-title">Project brief</h2></div><button type="button" class="subtle" id="close-preview">Close preview</button></div><p class="note">This preview updates as your team edits. It does not submit the form.</p><dl id="preview-content"></dl></dialog>`;
  const form = root.querySelector("form");
  const dialog = root.querySelector("dialog");
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function field(id, label, parent, required = false) {
    const node = element("div", "brief-field");
    node.dataset.field = id;
    const heading = element("div", "field-heading");
    const title = element("label", "", label);
    title.id = `label-${id}`;
    title.htmlFor = `field-${id}`;
    if (required) {
      const marker = element("span", "required-marker", " *");
      marker.setAttribute("aria-hidden", "true");
      title.append(marker);
    }
    const people = element("span", "field-people");
    people.id = `people-${id}`;
    const error = element("p", "field-error");
    error.id = `error-${id}`;
    error.hidden = true;
    heading.append(title, people);
    node.append(heading, error);
    parent.append(node);
    fields.set(id, { node, title, people, error });
    return node;
  }
  function publish() {
    room.awareness.setLocalStateField("multiplayerForm", activeField ? { field: activeField, action: readOnly ? "viewing" : "editing" } : null);
  }
  function activate(id) {
    if (activeField === id) return;
    model.history.stopCapturing();
    activeField = id;
    publish();
  }
  for (const spec of textFields) {
    const node = field(spec.id, spec.label, root.querySelector("#text-fields"), true);
    const mount = element("div", `brief-text ${spec.id === "name" ? "brief-name" : ""}`);
    node.insertBefore(mount, fields.get(spec.id).error);
    const permission = new Compartment();
    const editor = new EditorView({
      parent: mount,
      doc: model.texts[spec.id].toString(),
      extensions: [
        permission.of(EditorState.readOnly.of(true)),
        keymap.of([...yUndoManagerKeymap.map(binding => ({ ...binding, run: view => readOnly || binding.run(view) })), ...defaultKeymap]),
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
    on(fields.get(spec.id).title, "click", () => editor.focus());
    editors.set(spec.id, { editor, permission });
  }
  function input(id, label, tag, values, required = false) {
    const node = field(id, label, root.querySelector("#detail-fields"), required);
    const control = document.createElement(tag);
    control.id = `field-${id}`;
    control.name = id;
    control.required = required;
    control.setAttribute("aria-describedby", `people-${id} error-${id}`);
    if (tag === "select") {
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value || "Choose a team";
        control.append(option);
      }
    } else control.type = "date";
    node.insertBefore(control, fields.get(id).error);
    fields.get(id).control = control;
    on(control, "change", () => { if (!readOnly) model.set(id, control.value); });
  }
  input("team", "Team", "select", ["", ...teams], true);
  input("priority", "Priority", "select", priorities);
  input("date", "Target date", "input");
  const channelNode = field("channels", "Launch channels", root.querySelector("#channel-field"));
  const choices = element("div", "channel-options");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-labelledby", "label-channels");
  fields.get("channels").title.removeAttribute("for");
  for (const channel of channels) {
    const label = element("label", "channel-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = channel;
    checkbox.setAttribute("aria-describedby", "people-channels");
    label.append(checkbox, document.createTextNode(channel));
    choices.append(label);
    on(checkbox, "change", () => { if (!readOnly) model.set(`channel:${channel}`, checkbox.checked); });
  }
  channelNode.insertBefore(choices, fields.get("channels").error);
  channelNode.append(element("p", "note", "Choose as many as you need. You can decide later."));

  on(form, "focusin", event => {
    const id = event.target.closest("[data-field]")?.dataset.field;
    if (id) activate(id);
  });
  on(form, "focusout", event => {
    const id = event.target.closest("[data-field]")?.dataset.field;
    if (id) { touched.add(id); render(); }
    if (event.relatedTarget?.closest("[data-field]")?.dataset.field !== activeField) {
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
    const id = document.activeElement?.closest("[data-field]")?.dataset.field;
    if (id) activate(id);
  });
  on(document, "visibilitychange", () => { if (document.hidden) clearPresence(); });
  on(undo, "click", () => { if (!readOnly) model.history.undo(); });
  on(redo, "click", () => { if (!readOnly) model.history.redo(); });
  on(form, "keydown", event => {
    // Text editors handle these themselves, including cursor restoration.
    if (event.target.closest(".cm-editor") || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!["z", "y"].includes(key)) return;
    event.preventDefault();
    if (!readOnly) key === "y" || event.shiftKey ? model.history.redo() : model.history.undo();
  });
  on(form, "submit", event => {
    event.preventDefault();
    for (const id of fields.keys()) touched.add(id);
    render();
    const errors = validate(model.values());
    const first = Object.keys(errors)[0];
    if (first) {
      root.querySelector("#brief-announcement").textContent = "Complete the highlighted fields to review your brief.";
      if (editors.has(first)) editors.get(first).editor.focus();
      else fields.get(first).control.focus();
      return;
    }
    root.querySelector("#brief-announcement").textContent = "";
    renderPreview(model.values());
    dialog.showModal();
  });
  on(root.querySelector("#close-preview"), "click", () => dialog.close());

  function renderPreview(values) {
    const entries = [...textFields.map(spec => [spec.label, values[spec.id]]),
      ["Team", values.team], ["Priority", values.priority], ["Target date", values.date], ["Launch channels", values.channels.join(", ")]];
    root.querySelector("#preview-content").replaceChildren(...entries.flatMap(([label, value]) => [
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
    for (const [id, { control, error }] of fields) {
      if (control) {
        if (control.value !== values[id]) control.value = values[id];
        control.disabled = readOnly;
      }
      const message = touched.has(id) ? errors[id] ?? "" : "";
      if (error.textContent !== message) error.textContent = message;
      error.hidden = !message;
      const target = control ?? editors.get(id)?.editor.contentDOM;
      if (target) target.setAttribute("aria-invalid", String(Boolean(message)));
    }
    for (const checkbox of choices.querySelectorAll("input")) {
      checkbox.checked = values.channels.includes(checkbox.value);
      checkbox.disabled = readOnly;
    }
    const complete = requiredFields.filter(id => !errors[id]).length;
    root.querySelector("#brief-progress").value = complete;
    root.querySelector("#brief-completion").textContent = `${complete} of ${requiredFields.length} complete`;
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
  for (const text of Object.values(model.texts)) text.observe(render);
  model.properties.observe(render);
  room.awareness.on("change", renderPresence);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"]) model.history.on(event, renderHistory);
  render();
  function destroy() {
    disposed = true;
    events.abort();
    for (const text of Object.values(model.texts)) text.unobserve(render);
    model.properties.unobserve(render);
    room.awareness.off("change", renderPresence);
    for (const { editor } of editors.values()) editor.destroy();
    model.destroy();
    clearPresence();
    dialog.close();
    root.replaceChildren();
  }
  destroy.setReadOnly = value => {
    if (value !== readOnly) {
      readOnly = value;
      for (const { editor, permission } of editors.values()) editor.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(value)) });
      publish();
      render();
    }
    renderPresence();
  };
  return destroy;
}
