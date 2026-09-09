import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

export function createEditor(text, awareness) {
  let readOnly = true;
  const permission = new Compartment();
  // Yjs history commands bypass CodeMirror's readOnly state.
  const historyKeymap = yUndoManagerKeymap.map(binding => ({
    ...binding, run: view => readOnly || binding.run(view),
  }));
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set() });
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  const editor = new EditorView({
    doc: text.toString(),
    parent: document.querySelector("#editor"),
    extensions: [
      permission.of(EditorState.readOnly.of(true)),
      // Use Yjs history so undo never removes another participant's edits.
      keymap.of([...historyKeymap, ...defaultKeymap]),
      drawSelection(),
      EditorView.lineWrapping,
      placeholder("This document is empty."),
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
    undo.disabled = readOnly || !undoManager.canUndo();
    redo.disabled = readOnly || !undoManager.canRedo();
  }

  function undoEdit() { if (!readOnly) undoManager.undo(); editor.focus(); }
  function redoEdit() { if (!readOnly) undoManager.redo(); editor.focus(); }
  undo.addEventListener("click", undoEdit);
  redo.addEventListener("click", redoEdit);
  undoManager.on("stack-item-added", showHistory);
  undoManager.on("stack-item-popped", showHistory);
  showHistory();

  const destroy = () => {
    undo.removeEventListener("click", undoEdit);
    redo.removeEventListener("click", redoEdit);
    editor.destroy();
    undoManager.destroy();
  };
  destroy.setReadOnly = value => {
    if (readOnly === value) return;
    readOnly = value;
    editor.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(value)) });
    showHistory();
  };
  return destroy;
}
