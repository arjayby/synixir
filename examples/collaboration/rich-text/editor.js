import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration";
import { Plugin } from "@tiptap/pm/state";
import { yCursorPlugin } from "@tiptap/y-tiptap";

const color = user => /^#[0-9a-f]{6}$/i.test(user?.color) ? user.color : "#3565b0";
const safeUrl = value => {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
};

// CodeMirror also publishes `cursor`. Keep these relative positions separate,
// while exposing the field the ProseMirror binding expects to read and write.
function documentAwareness(awareness) {
  const state = value => value && ({ ...value, cursor: value.richTextCursor });
  return {
    getStates: () => new Map([...awareness.getStates()].map(([id, value]) => [id, state(value)])),
    getLocalState: () => state(awareness.getLocalState()),
    setLocalStateField: (key, value) => awareness.setLocalStateField(key === "cursor" ? "richTextCursor" : key, value),
    on: (...args) => awareness.on(...args),
    off: (...args) => awareness.off(...args),
  };
}

const SharedHistory = Collaboration.extend({
  addCommands() {
    // Yjs undo changes the shared document directly, even in a read-only view.
    return Object.fromEntries(Object.entries(this.parent()).map(([name, command]) => [name,
      (...args) => props => this.editor.isEditable && command(...args)(props),
    ]));
  },
});

export function createRichText(room) {
  const root = document.querySelector("#editor");
  root.innerHTML = `
    <div class="format-toolbar" role="group" aria-label="Text formatting">
      <select id="text-style" aria-label="Text style" disabled>
        <option value="paragraph">Paragraph</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option>
      </select>
      <div class="format-group">
        <button type="button" data-format="bold" aria-label="Bold" aria-pressed="false" disabled><strong>B</strong></button>
        <button type="button" data-format="italic" aria-label="Italic" aria-pressed="false" disabled><em>I</em></button>
        <button type="button" data-format="underline" aria-label="Underline" aria-pressed="false" disabled><u>U</u></button>
      </div>
      <div class="format-group">
        <button type="button" data-format="bulletList" aria-label="Bullet list" aria-pressed="false" disabled>• List</button>
        <button type="button" data-format="orderedList" aria-label="Numbered list" aria-pressed="false" disabled>1. List</button>
        <button type="button" data-format="blockquote" aria-label="Quote" aria-pressed="false" disabled>“ Quote</button>
      </div>
      <button id="edit-link" type="button" aria-label="Edit link" aria-pressed="false" disabled>Link</button>
    </div>
    <div class="rich-document"></div>
    <dialog class="link-dialog" aria-labelledby="link-title">
      <form id="link-form">
        <h2 id="link-title">Edit link</h2>
        <label for="link-url">Link URL</label><input id="link-url" type="url" placeholder="https://example.com" required />
        <p class="note">Use an http:// or https:// address.</p>
        <div class="actions"><button type="button" id="remove-link" class="subtle">Remove link</button><button type="button" id="cancel-link" class="subtle">Cancel</button><button type="submit">Apply link</button></div>
      </form>
    </dialog>`;
  document.querySelector("#open-peer").href = window.location.href;
  const toolbar = root.querySelector(".format-toolbar");
  const style = root.querySelector("#text-style");
  const dialog = root.querySelector("dialog");
  const url = root.querySelector("#link-url");
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  const cleanup = [];
  let readOnly = true;
  const on = (node, event, handler) => {
    node.addEventListener(event, handler);
    cleanup.push(() => node.removeEventListener(event, handler));
  };
  const presence = Extension.create({
    name: "documentPresence",
    addProseMirrorPlugins() {
      return [yCursorPlugin(documentAwareness(room.awareness), {
        cursorBuilder(user) {
          const caret = document.createElement("span");
          caret.className = "rich-caret";
          caret.style.borderColor = color(user);
          caret.setAttribute("aria-hidden", "true");
          const label = document.createElement("span");
          label.style.backgroundColor = color(user);
          label.textContent = typeof user.name === "string" ? user.name.slice(0, 32) : "Guest";
          caret.append(label);
          return caret;
        },
        selectionBuilder: user => ({ class: "rich-selection", style: `background-color: ${color(user)}33` }),
      }), new Plugin({
        // Formatting shortcuts must respect permissions as well as typing.
        filterTransaction: transaction => !readOnly || !transaction.docChanged || isChangeOrigin(transaction),
      })];
    },
  });
  const editor = new Editor({
    element: root.querySelector(".rich-document"),
    editable: false,
    extensions: [
      StarterKit.configure({ undoRedo: false, trailingNode: false, heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, defaultProtocol: "https", isAllowedUri: safeUrl } }),
      SharedHistory.configure({ document: room.doc, field: "rich-text:content:v1" }),
      presence,
    ],
    editorProps: { attributes: {
      "aria-label": "Rich text document", "aria-describedby": "editor-help", "aria-multiline": "true", role: "textbox", spellcheck: "true",
    } },
  });

  function render() {
    for (const button of toolbar.querySelectorAll("button")) button.disabled = readOnly;
    style.disabled = readOnly;
    const heading = editor.getAttributes("heading").level;
    style.value = heading ? String(heading) : "paragraph";
    for (const button of toolbar.querySelectorAll("[data-format]")) button.setAttribute("aria-pressed", editor.isActive(button.dataset.format));
    root.querySelector("#edit-link").setAttribute("aria-pressed", editor.isActive("link"));
    undo.disabled = readOnly || !editor.can().undo();
    redo.disabled = readOnly || !editor.can().redo();
    const text = editor.getText().trim();
    const words = text ? text.split(/\s+/u).length : 0;
    document.querySelector("#word-count").textContent = `${words} ${words === 1 ? "word" : "words"}`;
    editor.view.dom.dataset.empty = editor.isEmpty;
    editor.view.dom.setAttribute("aria-readonly", String(readOnly));
  }
  editor.on("transaction", render);
  const commands = { bold: "toggleBold", italic: "toggleItalic", underline: "toggleUnderline",
    bulletList: "toggleBulletList", orderedList: "toggleOrderedList", blockquote: "toggleBlockquote" };
  on(toolbar, "mousedown", event => { if (event.target.closest("button")) event.preventDefault(); });
  on(toolbar, "click", event => {
    const button = event.target.closest("[data-format]");
    if (button && !readOnly) editor.chain().focus()[commands[button.dataset.format]]().run();
  });
  on(style, "change", () => {
    if (readOnly) return;
    const chain = editor.chain().focus();
    if (style.value === "paragraph") chain.setParagraph().run();
    else chain.setHeading({ level: Number(style.value) }).run();
  });
  on(undo, "click", () => { if (!readOnly) editor.chain().focus().undo().run(); });
  on(redo, "click", () => { if (!readOnly) editor.chain().focus().redo().run(); });
  on(root.querySelector("#edit-link"), "click", () => {
    if (readOnly) return;
    url.value = editor.getAttributes("link").href ?? "";
    url.setCustomValidity("");
    root.querySelector("#remove-link").disabled = !editor.isActive("link");
    dialog.showModal();
    url.focus();
  });
  on(url, "input", () => url.setCustomValidity(""));
  on(root.querySelector("#link-form"), "submit", event => {
    event.preventDefault();
    if (readOnly) return;
    const href = url.value.trim();
    if (!safeUrl(href)) {
      url.setCustomValidity("Enter an http:// or https:// address.");
      url.reportValidity();
      return;
    }
    dialog.close();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else chain.setLink({ href }).run();
  });
  on(root.querySelector("#remove-link"), "click", () => {
    dialog.close();
    if (!readOnly) editor.chain().focus().extendMarkRange("link").unsetLink().run();
  });
  on(root.querySelector("#cancel-link"), "click", () => { dialog.close(); editor.commands.focus(); });
  render();
  const destroy = () => {
    cleanup.forEach(stop => stop());
    editor.destroy();
  };
  destroy.setReadOnly = value => {
    if (value === readOnly) return;
    readOnly = value;
    if (value) dialog.close();
    editor.setEditable(!value);
    render();
  };
  return destroy;
}
