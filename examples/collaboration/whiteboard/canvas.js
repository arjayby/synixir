import { createWhiteboardModel, canvasSize, colors } from "./model.js";
import { createMotion } from "./motion.js";

export function createWhiteboard(room) {
  const root = document.querySelector("#editor");
  document.querySelector("#open-peer").href = window.location.href;
  const model = createWhiteboardModel(room.doc);
  const motion = createMotion();
  let items = model.list();
  let activityFrame;
  const events = new AbortController();
  const on = (target, event, handler) => target.addEventListener(event, handler, { signal: events.signal });
  const nodes = new Map();
  const peerNodes = new Map();
  let readOnly = true;
  let selectedId = null;
  let drag = null;
  let cursor = null;
  let zoom = 1;
  let presenceTimer;
  let lastPresenceAt = -Infinity;
  let disposed = false;
  const undo = document.querySelector("#undo");
  const redo = document.querySelector("#redo");
  const announce = text => { document.querySelector("#board-announcement").textContent = text; };
  root.innerHTML = `
    <div class="whiteboard-tools" aria-label="Whiteboard tools">
      <div class="object-tools"><button type="button" data-add="sticky" disabled>+ Sticky note</button><button type="button" data-add="rectangle" disabled>□ Rectangle</button><button type="button" data-add="ellipse" disabled>○ Ellipse</button></div>
      <div class="zoom-tools"><button type="button" id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-level" aria-label="Zoom level">100%</output><button type="button" id="zoom-in" aria-label="Zoom in">+</button><button type="button" id="zoom-reset">100%</button></div>
    </div>
    <div id="whiteboard-viewport" tabindex="0" aria-label="Whiteboard canvas" aria-describedby="canvas-help">
      <div class="canvas-sizer"><div class="whiteboard-canvas"><div class="object-layer"></div><div class="presence-layer" aria-hidden="true"></div><div class="canvas-empty">A little space to think.<span>Add a sticky note or shape to begin.</span></div></div></div>
    </div>
    <div class="canvas-summary"><span id="object-count" aria-live="polite">0 objects</span><span id="canvas-help">Scroll to explore · Select an object to edit</span></div>
    <section class="object-inspector" aria-label="Selected object">
      <p id="selection-empty">Select a note or shape to change its text, color, and size.</p>
      <div id="selection-fields" hidden>
        <div class="inspector-heading"><h2 id="selection-title">Object</h2><div><button type="button" id="bring-front" class="subtle">Bring to front</button><button type="button" id="delete-object" class="subtle">Delete object</button></div></div>
        <div class="inspector-fields"><div class="object-text-field"><label for="object-text">Object text</label><textarea id="object-text" rows="3" maxlength="2000" placeholder="Add a label or an idea"></textarea></div>
          <div><label for="object-color">Object color</label><select id="object-color"></select></div>
          <div><label for="object-width">Width</label><input id="object-width" type="number" min="80" max="600" step="10" /></div>
          <div><label for="object-height">Height</label><input id="object-height" type="number" min="60" max="500" step="10" /></div>
        </div>
      </div>
    </section>`;
  const viewport = root.querySelector("#whiteboard-viewport");
  const sizer = root.querySelector(".canvas-sizer");
  const canvas = root.querySelector(".whiteboard-canvas");
  const layer = root.querySelector(".object-layer");
  const presenceLayer = root.querySelector(".presence-layer");
  const textInput = root.querySelector("#object-text");
  const colorInput = root.querySelector("#object-color");
  const widthInput = root.querySelector("#object-width");
  const heightInput = root.querySelector("#object-height");
  canvas.style.width = `${canvasSize.width}px`;
  canvas.style.height = `${canvasSize.height}px`;
  for (const color of colors) {
    const option = document.createElement("option");
    option.value = color;
    option.textContent = color[0].toUpperCase() + color.slice(1);
    colorInput.append(option);
  }
  const selected = () => items.find(item => item.id === selectedId);
  const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= canvasSize.width && point.y <= canvasSize.height;
  const worldPoint = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  };
  function publish() {
    clearTimeout(presenceTimer);
    presenceTimer = undefined;
    if (disposed) return;
    lastPresenceAt = performance.now();
    room.awareness.setLocalStateField("whiteboard", { cursor, selectedId,
      drag: drag?.moved ? { id: drag.id, ...drag.position } : null });
  }
  function schedulePresence() {
    if (presenceTimer !== undefined) return;
    const remaining = 60 - (performance.now() - lastPresenceAt);
    if (remaining <= 0) publish();
    else presenceTimer = setTimeout(publish, remaining);
  }
  function select(id) {
    selectedId = id;
    model.history.stopCapturing();
    render();
    publish();
  }
  function cancelDrag() {
    const previous = drag;
    drag = null;
    if (previous && viewport.hasPointerCapture(previous.pointerId)) viewport.releasePointerCapture(previous.pointerId);
    publish();
    scheduleActivity();
  }
  function setZoom(value) {
    cancelDrag();
    const center = { x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom };
    zoom = Math.min(1.5, Math.max(0.5, value));
    canvas.style.transform = `scale(${zoom})`;
    sizer.style.width = `${canvasSize.width * zoom}px`;
    sizer.style.height = `${canvasSize.height * zoom}px`;
    viewport.scrollLeft = center.x * zoom - viewport.clientWidth / 2;
    viewport.scrollTop = center.y * zoom - viewport.clientHeight / 2;
    root.querySelector("#zoom-level").textContent = `${Math.round(zoom * 100)}%`;
    root.querySelector("#zoom-out").disabled = zoom <= 0.5;
    root.querySelector("#zoom-in").disabled = zoom >= 1.5;
    cursor = null;
    publish();
  }
  on(root.querySelector("#zoom-in"), "click", () => setZoom(zoom + 0.25));
  on(root.querySelector("#zoom-out"), "click", () => setZoom(zoom - 0.25));
  on(root.querySelector("#zoom-reset"), "click", () => setZoom(1));
  root.querySelectorAll("[data-add]").forEach(button => on(button, "click", () => {
    if (readOnly) return;
    cancelDrag();
    const offset = model.list().length % 5 * 24;
    const id = model.add(button.dataset.add, { x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom - 110 + offset,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom - 90 + offset });
    select(id);
    textInput.focus();
    textInput.select();
    announce("Object added.");
  }));
  on(viewport, "pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const node = event.target.closest(".whiteboard-object");
    if (!node) { select(null); return; }
    event.preventDefault();
    node.focus({ preventScroll: true });
    select(node.dataset.objectId);
    const item = selected();
    if (readOnly || !item) return;
    const point = worldPoint(event);
    drag = { id: item.id, pointerId: event.pointerId, start: point, original: item.position,
      position: item.position, size: item.size, moved: false };
    viewport.setPointerCapture(event.pointerId);
  });
  on(viewport, "pointermove", event => {
    const point = worldPoint(event);
    cursor = validPoint(point) ? point : null;
    if (drag && event.pointerId === drag.pointerId && !readOnly) {
      if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 2) drag.moved = true;
      drag.position = model.boundedPosition({ x: drag.original.x + point.x - drag.start.x,
        y: drag.original.y + point.y - drag.start.y }, drag.size);
      scheduleActivity();
    }
    schedulePresence();
  });
  on(viewport, "pointerup", event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const completed = drag;
    drag = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (!readOnly && completed.moved) {
      model.move(completed.id, completed.position);
      announce("Object moved.");
    }
    publish();
    scheduleActivity();
  });
  on(viewport, "pointercancel", cancelDrag);
  on(viewport, "lostpointercapture", () => { if (drag) cancelDrag(); });
  on(viewport, "pointerleave", () => { cursor = null; publish(); });
  on(viewport, "scroll", () => { cursor = null; schedulePresence(); });
  on(window, "blur", () => { cursor = null; cancelDrag(); });
  on(document, "visibilitychange", () => { if (document.hidden) { cursor = null; cancelDrag(); } });
  on(viewport, "click", event => {
    const node = event.target.closest(".whiteboard-object");
    if (node) select(node.dataset.objectId);
  });
  on(root, "keydown", event => {
    if (event.key === "Escape") {
      if (drag) cancelDrag();
      else select(null);
      viewport.focus({ preventScroll: true });
      return;
    }
    if (readOnly || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      cancelDrag();
      if (event.shiftKey) model.history.redo(); else model.history.undo();
      return;
    }
    if (event.target !== viewport && !event.target.closest(".whiteboard-object")) return;
    const item = selected();
    if (!item) return;
    if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); model.remove(item.id); return; }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (delta) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      model.move(item.id, { x: item.position.x + delta[0] * step, y: item.position.y + delta[1] * step });
    }
  });
  for (const [input, field] of [[textInput, "text"], [colorInput, "color"]]) {
    on(input, "focus", () => model.history.stopCapturing());
    on(input, "blur", () => model.history.stopCapturing());
    on(input, "input", () => { if (!readOnly && selectedId) model.edit(selectedId, field, input.value); });
  }
  for (const input of [widthInput, heightInput]) on(input, "change", () => {
    if (!readOnly && selectedId) model.resize(selectedId, { width: widthInput.valueAsNumber, height: heightInput.valueAsNumber });
    renderInspector();
  });
  on(root.querySelector("#bring-front"), "click", () => { if (!readOnly && selectedId) model.front(selectedId); });
  on(root.querySelector("#delete-object"), "click", () => { if (!readOnly && selectedId) model.remove(selectedId); });
  on(undo, "click", () => { if (!readOnly) { cancelDrag(); model.history.undo(); } });
  on(redo, "click", () => { if (!readOnly) { cancelDrag(); model.history.redo(); } });

  function peers() {
    if (room.state.connection !== "connected") return [];
    return [...room.awareness.getStates()].filter(([id, state]) => id !== room.awareness.clientID && state.whiteboard)
      .sort(([a], [b]) => a - b).map(([id, state]) => ({ id, ...state.whiteboard,
        name: typeof state.user?.name === "string" ? state.user.name.slice(0, 32) : "Guest",
        color: /^#[0-9a-f]{6}$/i.test(state.user?.color) ? state.user.color : "#3565b0" }));
  }
  function scheduleActivity() {
    if (!disposed && activityFrame === undefined) activityFrame = requestAnimationFrame(renderActivity);
  }
  function syncObjects() {
    const present = new Set(items.map(item => item.id));
    for (const [id, node] of nodes) if (!present.has(id)) {
      motion.forget(node);
      node.remove();
      nodes.delete(id);
    }
    items.forEach((item, index) => {
      let node = nodes.get(item.id);
      if (!node) {
        node = document.createElement("button");
        node.type = "button";
        node.dataset.objectId = item.id;
        nodes.set(item.id, node);
        layer.append(node);
      }
      node.className = `whiteboard-object object-${item.kind} color-${item.color}`;
      node.classList.toggle("is-selected", selectedId === item.id);
      node.setAttribute("aria-pressed", String(selectedId === item.id));
      node.setAttribute("aria-label", `${item.kind === "sticky" ? "Sticky note" : item.kind === "ellipse" ? "Ellipse" : "Rectangle"}: ${item.text || "Untitled"}`);
      if (node.textContent !== item.text) node.textContent = item.text;
      Object.assign(node.style, { width: `${item.size.width}px`, height: `${item.size.height}px`, zIndex: String(index) });
    });
    root.querySelector(".canvas-empty").hidden = items.length > 0;
    const count = `${items.length} ${items.length === 1 ? "object" : "objects"}`;
    if (root.querySelector("#object-count").textContent !== count) root.querySelector("#object-count").textContent = count;
  }
  function renderActivity() {
    activityFrame = undefined;
    if (disposed) return;
    const remote = peers();
    const displayed = new Map();
    for (const item of items) {
      const node = nodes.get(item.id);
      if (!node) continue;
      const ownDrag = drag?.id === item.id;
      const remoteDrag = remote.findLast(peer => peer.drag?.id === item.id && validPoint(peer.drag))?.drag;
      const preview = ownDrag ? drag.position : remoteDrag;
      const position = preview ? model.boundedPosition(preview, item.size) : item.position;
      const smooth = !ownDrag && (Boolean(remoteDrag) || motion.moving(node));
      motion.move(node, position, smooth);
      displayed.set(item.id, { position, smooth });
    }
    const presentPeers = new Set(remote.map(peer => peer.id));
    for (const [id, pair] of peerNodes) if (!presentPeers.has(id)) {
      motion.forget(pair.ring);
      motion.forget(pair.pointer);
      pair.ring?.remove();
      pair.pointer?.remove();
      peerNodes.delete(id);
    }
    for (const peer of remote) {
      let pair = peerNodes.get(peer.id);
      if (!pair) { pair = {}; peerNodes.set(peer.id, pair); }
      const item = items.find(item => item.id === peer.selectedId);
      if (item) {
        if (!pair.ring) {
          pair.ring = document.createElement("div");
          pair.ring.className = "remote-selection";
          pair.ring.append(document.createElement("span"));
          presenceLayer.append(pair.ring);
        }
        const node = nodes.get(item.id);
        const ring = pair.ring;
        if (ring.dataset.peerSelection !== item.id) motion.forget(ring);
        ring.dataset.peerSelection = item.id;
        const display = displayed.get(item.id);
        motion.move(ring, display.position, display.smooth);
        Object.assign(ring.style, { width: node.style.width, height: node.style.height, borderColor: peer.color });
        const label = ring.firstChild;
        if (label.textContent !== peer.name) label.textContent = peer.name;
        label.style.background = peer.color;
      } else { motion.forget(pair.ring); pair.ring?.remove(); pair.ring = null; }
      if (validPoint(peer.cursor)) {
        if (!pair.pointer) {
          pair.pointer = document.createElement("div");
          pair.pointer.className = "remote-cursor";
          const arrow = document.createElement("span");
          arrow.textContent = "↖";
          pair.pointer.append(arrow, document.createElement("span"));
          presenceLayer.append(pair.pointer);
        }
        const pointer = pair.pointer;
        motion.move(pointer, peer.cursor);
        pointer.style.color = peer.color;
        const label = pointer.lastChild;
        if (label.textContent !== peer.name) label.textContent = peer.name;
        label.style.background = peer.color;
      } else { motion.forget(pair.pointer); pair.pointer?.remove(); pair.pointer = null; }
    }
  }

  function renderInspector() {
    const item = selected();
    root.querySelector("#selection-empty").hidden = Boolean(item);
    root.querySelector("#selection-fields").hidden = !item;
    if (!item) return;
    root.querySelector("#selection-title").textContent = item.kind === "sticky" ? "Sticky note" : item.kind === "ellipse" ? "Ellipse" : "Rectangle";
    if (textInput.value !== item.text) {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      textInput.value = item.text;
      if (document.activeElement === textInput) textInput.setSelectionRange(Math.min(start, item.text.length), Math.min(end, item.text.length));
    }
    colorInput.value = item.color;
    widthInput.value = item.size.width;
    heightInput.value = item.size.height;
    textInput.readOnly = readOnly;
    for (const input of [colorInput, widthInput, heightInput, root.querySelector("#bring-front"), root.querySelector("#delete-object")]) input.disabled = readOnly;
  }
  function renderHistory() {
    undo.disabled = readOnly || !model.history.canUndo();
    redo.disabled = readOnly || !model.history.canRedo();
  }
  function render() {
    if (disposed) return;
    items = model.list();
    if (selectedId && !items.some(item => item.id === selectedId)) {
      selectedId = null;
      cancelDrag();
      publish();
      viewport.focus({ preventScroll: true });
      announce("The selected object was removed.");
    }
    syncObjects();
    scheduleActivity();
    renderInspector();
    renderHistory();
  }
  model.objects.observeDeep(render);
  room.awareness.on("change", scheduleActivity);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"]) model.history.on(event, renderHistory);
  setZoom(1);
  render();
  function destroy() {
    disposed = true;
    clearTimeout(presenceTimer);
    cancelAnimationFrame(activityFrame);
    motion.destroy();
    peerNodes.clear();
    events.abort();
    model.objects.unobserveDeep(render);
    room.awareness.off("change", scheduleActivity);
    model.destroy();
    nodes.clear();
    root.replaceChildren();
  }
  destroy.setReadOnly = value => {
    if (readOnly !== value) {
      readOnly = value;
      if (readOnly) cancelDrag();
      root.querySelectorAll("[data-add]").forEach(button => { button.disabled = readOnly; });
      render();
    }
    scheduleActivity();
  };
  return destroy;
}
