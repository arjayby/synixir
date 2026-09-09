import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

export function createEditor(text, awareness) {
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set() });
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  const editor = new EditorView({
    doc: text.toString(),
    parent: document.querySelector("#editor"),
    extensions: [
      // Use Yjs history so undo never removes another participant's edits.
      keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
      drawSelection(),
      EditorView.lineWrapping,
      placeholder("Start writing. Everyone in this room can edit here."),
      EditorView.contentAttributes.of({
        "aria-label": "Shared document",
        "aria-describedby": "editor-help",
        spellcheck: "true",
      }),
      EditorView.domEventHandlers({
        blur: () => { awareness.setLocalStateField("cursor", null); },
      }),
      yCollab(text, awareness, { undoManager }),
    ],
  });

  function showHistory() {
    undo.disabled = !undoManager.canUndo();
    redo.disabled = !undoManager.canRedo();
  }

  function undoEdit() { undoManager.undo(); editor.focus(); }
  function redoEdit() { undoManager.redo(); editor.focus(); }
  undo.addEventListener("click", undoEdit);
  redo.addEventListener("click", redoEdit);
  undoManager.on("stack-item-added", showHistory);
  undoManager.on("stack-item-popped", showHistory);
  showHistory();

  return () => {
    undo.removeEventListener("click", undoEdit);
    redo.removeEventListener("click", redoEdit);
    editor.destroy();
    undoManager.destroy();
  };
}
