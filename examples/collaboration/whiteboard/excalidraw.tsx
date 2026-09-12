"use client";
import "./assets.ts";
import { createRoot } from "react-dom/client";
import { Excalidraw, CaptureUpdateAction, MainMenu, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Collaborator, ExcalidrawImperativeAPI, ExcalidrawProps, SocketId } from "@excalidraw/excalidraw/types";
import type { SynixirRoom } from "@synixir/client";
import { createWhiteboardModel, sameScene } from "./model.ts";
import { createCursorMotion } from "../lib/cursor-motion.ts";

declare global { interface Window { synixirWhiteboardTest?: ExcalidrawImperativeAPI } }
const cloneScene = (scene: readonly ExcalidrawElement[]): ExcalidrawElement[] => JSON.parse(JSON.stringify(scene));
const unsupported = (element: ExcalidrawElement) => ["image", "iframe", "embeddable", "magicframe"].includes(element.type);

export function createWhiteboard(room: SynixirRoom) {
  const host = document.querySelector<HTMLElement>("#editor")!;
  // This editor owns its controls' styles. The shared surface rules style the
  // small DOM examples and would override Excalidraw's toolbar and text editor.
  host.classList.replace("surface", "whiteboard-surface");
  const root = createRoot(host);
  const model = createWhiteboardModel(room.doc);
  const events = new AbortController();
  const undo = document.querySelector<HTMLButtonElement>("#undo")!;
  const redo = document.querySelector<HTMLButtonElement>("#redo")!;
  const count = document.querySelector<HTMLElement>("#word-count")!;
  let api: ExcalidrawImperativeAPI | undefined;
  let initialized = false;
  let previous: ExcalidrawElement[] = [];
  let disposed = false;
  let readOnly = true;
  let localWrite = false;
  let rendering = false;
  let pendingFrame: number | undefined;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPresence = "";
  let lastPublished = -Infinity;
  let peerTargets = new Map<SocketId, Collaborator>();
  let lastPeers = "";
  const cursorMotion = createCursorMotion<SocketId>(paintCollaborators);
  let pointer: { x: number; y: number; tool: "pointer" | "laser" } | null = null;
  let button: "up" | "down" = "up";
  let selectedElementIds: Record<string, boolean> = {};
  let lastCount = "";
  let positionedScene = false;

  function historyState() {
    undo.disabled = readOnly || !model.history.canUndo();
    redo.disabled = readOnly || !model.history.canRedo();
  }
  function updateCount(elements: readonly ExcalidrawElement[]) {
    const total = elements.filter(element => !element.isDeleted).length;
    const value = `${total} ${total === 1 ? "object" : "objects"}`;
    if (lastCount !== value) { count.textContent = value; lastCount = value; }
  }
  function paint() {
    if (disposed || !api || !initialized) return;
    const elements = restoreElements(model.list(), null, { repairBindings: true });
    previous = cloneScene(elements);
    rendering = true;
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    rendering = false;
    api.history.clear();
    if (!positionedScene && elements.some(element => !element.isDeleted)) {
      positionedScene = true;
      api.scrollToContent(elements.filter(element => !element.isDeleted), { fitToContent: true, animate: false });
    }
    updateCount(elements);
    historyState();
  }
  function schedulePaint() {
    if (pendingFrame === undefined) pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined;
      paint();
    });
  }
  const stopModel = model.observe(transaction => {
    if (!localWrite && transaction.origin !== model.origin) paint();
    historyState();
  });

  function publish() {
    clearTimeout(presenceTimer);
    presenceTimer = undefined;
    if (disposed) return;
    const state = { pointer, button, selectedElementIds };
    const encoded = JSON.stringify(state);
    if (encoded === lastPresence) return;
    lastPresence = encoded;
    lastPublished = performance.now();
    room.awareness.setLocalStateField("whiteboard", state);
  }
  function schedulePresence() {
    if (presenceTimer !== undefined) return;
    const delay = 60 - (performance.now() - lastPublished);
    if (delay <= 0) publish(); else presenceTimer = setTimeout(publish, delay);
  }
  function clearPointer() { pointer = null; button = "up"; publish(); }
  function paintCollaborators() {
    if (disposed || !api || !initialized) return;
    const peers = new Map<SocketId, Collaborator>();
    for (const [id, peer] of peerTargets) {
      const point = cursorMotion.get(id);
      peers.set(id, { ...peer, ...(point ? { pointer: { ...point, tool: "pointer" as const } } : {}) });
    }
    api.updateScene({ collaborators: peers, captureUpdate: CaptureUpdateAction.NEVER });
  }
  function collaborators() {
    if (disposed || !api || !initialized) return;
    const peers = new Map<SocketId, Collaborator>();
    if (room.state.connection === "connected") for (const [id, state] of room.awareness.getStates()) {
      if (id === room.awareness.clientID || !state.whiteboard) continue;
      const remote = state.whiteboard;
      const color = /^#[0-9a-f]{6}$/i.test(state.user?.color) ? state.user.color : "#3565b0";
      const selected = Object.fromEntries(Object.entries(remote.selectedElementIds ?? {})
        .filter(([id, value]) => id.length <= 256 && value === true).map(([id]) => [id, true as const]));
      peers.set(String(id) as SocketId, {
        username: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest",
        color: { background: color, stroke: color },
        selectedElementIds: selected,
        button: remote.button === "down" ? "down" : "up",
        ...(remote.pointer && Number.isFinite(remote.pointer.x) && Number.isFinite(remote.pointer.y)
          ? { pointer: { x: remote.pointer.x, y: remote.pointer.y, tool: "pointer" as const } } : {}),
      });
    }
    const encoded = JSON.stringify([...peers]);
    if (encoded === lastPeers) return;
    lastPeers = encoded;
    peerTargets = peers;
    cursorMotion.update(new Map([...peers].flatMap(([id, peer]) => peer.pointer ? [[id, peer.pointer] as const] : [])));
    paintCollaborators();
  }
  room.awareness.on("change", collaborators);
  const stopState = room.subscribe(collaborators);

  const onChange: ExcalidrawProps["onChange"] = (elements, appState) => {
    if (disposed || rendering) return;
    if (!initialized) { initialized = true; paint(); collaborators(); return; }
    const selected = appState.selectedElementIds;
    if (JSON.stringify(selected) !== JSON.stringify(selectedElementIds)) {
      selectedElementIds = { ...selected };
      schedulePresence();
    }
    // Excalidraw calls onChange for cursor/app-state updates too. Element
    // revisions change on edits, so presence frames need no scene diff or Yjs
    // transaction. Compare each revision, including order, without hashing it.
    const unchanged = elements.length === previous.length && elements.every((element, index) =>
      element.id === previous[index].id && element.version === previous[index].version && element.versionNonce === previous[index].versionNonce);
    if (unchanged) return;
    if (readOnly) { if (!sameScene(elements, previous)) schedulePaint(); return; }
    // File import and image insertion are disabled. Also reject clipboard,
    // library, and keyboard paths which may bypass the visible tool options.
    if (elements.some(unsupported)) { schedulePaint(); return; }
    localWrite = true;
    if (model.apply(elements, previous) && elements.some(element => !element.isDeleted)) positionedScene = true;
    localWrite = false;
    previous = cloneScene(elements);
    api?.history.clear();
    updateCount(elements);
    historyState();
  };
  const onPointerUpdate: ExcalidrawProps["onPointerUpdate"] = value => {
    pointer = value.pointer;
    button = value.button;
    schedulePresence();
  };
  const ready = (value: ExcalidrawImperativeAPI) => {
    if (disposed) return;
    api = value;
    if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_SYNIXIR_BROWSER_TEST === "true")
      window.synixirWhiteboardTest = value;
    queueMicrotask(() => {
      if (!disposed && !value.getAppState().isLoading) { initialized = true; paint(); collaborators(); }
    });
  };
  const initialData = { elements: [], appState: { currentItemFontFamily: 2, viewBackgroundColor: "#ffffff" } };
  const uiOptions = { tools: { image: false }, canvasActions: {
    loadScene: false, saveToActiveFile: false, changeViewBackgroundColor: false,
  } };
  function render() {
    root.render(<div className="excalidraw-shell" aria-label="Whiteboard canvas">
      <Excalidraw excalidrawAPI={ready} initialData={initialData} onChange={onChange}
        onPointerUpdate={onPointerUpdate} onPointerDown={() => model.beginGesture()}
        onPointerUp={() => model.endGesture()} viewModeEnabled={readOnly} isCollaborating
        UIOptions={uiOptions} aiEnabled={false} validateEmbeddable={false}
        onPaste={data => !readOnly && !Object.keys(data.files ?? {}).length && !data.elements?.some(unsupported)}>
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>);
  }
  function undoLocal(redoAction = false) {
    if (readOnly) return;
    model.endGesture();
    if (redoAction) model.history.redo(); else model.history.undo();
    api?.history.clear();
  }
  undo.addEventListener("click", () => undoLocal(), { signal: events.signal });
  redo.addEventListener("click", () => undoLocal(true), { signal: events.signal });
  host.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      undoLocal(event.shiftKey || event.key.toLowerCase() === "y");
    }
  }, { signal: events.signal, capture: true });
  host.addEventListener("drop", event => {
    if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { signal: events.signal, capture: true });
  host.addEventListener("paste", event => {
    if (event.clipboardData?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { signal: events.signal, capture: true });
  host.addEventListener("pointerleave", clearPointer, { signal: events.signal });
  window.addEventListener("blur", clearPointer, { signal: events.signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearPointer(); }, { signal: events.signal });
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const)
    model.history.on(event, historyState);
  render();

  function destroy() {
    disposed = true;
    clearTimeout(presenceTimer);
    cursorMotion.destroy();
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    stopModel(); stopState();
    room.awareness.off("change", collaborators);
    room.awareness.setLocalStateField("whiteboard", null);
    events.abort();
    model.destroy();
    delete window.synixirWhiteboardTest;
    root.unmount();
    host.classList.replace("whiteboard-surface", "surface");
    count.textContent = "";
  }
  destroy.setReadOnly = (value: boolean) => {
    if (readOnly !== value) {
      readOnly = value;
      if (readOnly) {
        model.endGesture();
        selectedElementIds = {};
        clearPointer();
        api?.updateScene({ appState: { selectedElementIds: {}, editingTextElement: null }, captureUpdate: CaptureUpdateAction.NEVER });
        paint();
      }
      render();
      historyState();
    }
    collaborators();
  };
  return destroy;
}
