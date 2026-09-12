import type { SynixirRoom } from "@synixir/client";
import { createFlowchartModel, canvasSize, colors } from "./model.ts";
import { connectionPath } from "./geometry.ts";
import { createMotion } from "../whiteboard/motion.ts";

export function createFlowchart(room: SynixirRoom) {
  const kindLabel = (kind: string) => ({ process: "Process", decision: "Decision", terminal: "Start / End" } as Record<string, string>)[kind] ?? "Node";
  const root = document.querySelector<HTMLElement>("#editor")!;
  document.querySelector<HTMLAnchorElement>("#open-peer")!.href = window.location.href;
  const model = createFlowchartModel(room.doc);
  const painted = new Map();
  const edgeNodes = new Map();
  let edgeFrame: number|undefined;
  const motion = createMotion({ onPaint(node: HTMLElement, point: import("../lib/canvas-data.ts").Point) {
    if (node.dataset.objectId) {
      painted.set(node.dataset.objectId, point);
      // Paint in the same frame as the node so arrows stay attached throughout
      // interpolation, even when no new presence packet has arrived.
      paintEdges();
    }
  } });
  let items = model.list();
  let activityFrame: number|undefined;
  const events = new AbortController();
  const on = <K extends keyof DocumentEventMap>(target: EventTarget, event: K, handler: (event: DocumentEventMap[K]) => void, capture = false) => target.addEventListener(event, handler as EventListener, { signal: events.signal, capture });
  const nodes = new Map();
  const peerNodes = new Map();
  let readOnly = true;
  let selectedId: string|null = null;
  let selectedEdgeId: string|null = null;
  let connecting = false;
  let drag: { moved: any; id: any; position: any; pointerId: any; start: any; original: any; size: any; }|null = null;
  let cursor: { x: number; y: number; }|null = null;
  let zoom = 1;
  let presenceTimer: string|number|NodeJS.Timeout|undefined;
  let lastPresenceAt = -Infinity;
  let disposed = false;
  const undo = document.querySelector<HTMLButtonElement>("#undo")!;
  const redo = document.querySelector<HTMLButtonElement>("#redo")!;
  const announce = (text: string|null) => { document.querySelector<HTMLElement>("#board-announcement")!.textContent = text; };
  root.innerHTML = `
    <div class="whiteboard-tools" aria-label="Flowchart tools">
      <div class="object-tools"><button type="button" data-add="process" disabled>+ Process</button><button type="button" data-add="decision" disabled>◇ Decision</button><button type="button" data-add="terminal" disabled>○ Start / End</button></div>
      <div class="zoom-tools"><button type="button" id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-level" aria-label="Zoom level">100%</output><button type="button" id="zoom-in" aria-label="Zoom in">+</button><button type="button" id="zoom-reset">100%</button></div>
    </div>
    <div id="whiteboard-viewport" tabindex="0" aria-label="Flowchart canvas" aria-describedby="canvas-help">
      <div class="canvas-sizer"><div class="whiteboard-canvas"><svg class="edge-layer" aria-label="Connections"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs><g class="edges"></g></svg><div class="object-layer"></div><div class="presence-layer" aria-hidden="true"></div><div class="canvas-empty">Every process starts somewhere.<span>Add a step, then connect it to the next one.</span></div></div></div>
    </div>
    <div class="canvas-summary"><span id="object-count" aria-live="polite">0 nodes</span><span id="canvas-help">Scroll to explore · Select a node to edit or connect</span></div>
    <section class="object-inspector" aria-label="Selected node">
      <p id="selection-empty">Select a node to edit it, or an arrow to label a branch.</p>
      <div id="selection-fields" hidden>
        <div class="inspector-heading"><h2 id="selection-title">Object</h2><div><button type="button" id="bring-front" class="subtle">Bring to front</button><button type="button" id="delete-object" class="subtle">Delete node</button></div></div>
        <div class="inspector-fields"><div class="object-text-field"><label for="object-text">Node text</label><textarea id="object-text" rows="3" maxlength="2000" placeholder="Name this step"></textarea></div>
          <div><label for="object-color">Node color</label><select id="object-color"></select></div>
          <div><label for="object-width">Width</label><input id="object-width" type="number" min="80" max="600" step="10" /></div>
          <div><label for="object-height">Height</label><input id="object-height" type="number" min="60" max="500" step="10" /></div>
        </div>
        <div class="connect-fields">
          <div><label for="connection-target">Connect to</label><select id="connection-target"></select></div>
          <div><label for="connection-label">Branch label</label><input id="connection-label" maxlength="80" placeholder="e.g. Yes, No, Approved" /></div>
          <button type="button" id="add-connection">Connect nodes</button>
          <button type="button" id="pick-target" class="subtle" aria-pressed="false">Pick on canvas</button>
        </div>
      </div>
      <div id="edge-fields" hidden><div class="inspector-heading"><h2>Connection</h2><button type="button" id="delete-connection" class="subtle">Delete connection</button></div>
        <label for="edge-label">Connection label</label><input id="edge-label" maxlength="80" placeholder="e.g. Yes or No" />
      </div>
    </section>
    <section class="flow-connections" aria-label="Flowchart connections"><h2>Connections</h2><p id="connections-empty">Connect two nodes to show what happens next.</p><ul id="connection-list"></ul></section>`;
  const viewport = root.querySelector<HTMLElement>("#whiteboard-viewport")!;
  const sizer = root.querySelector<HTMLElement>(".canvas-sizer")!;
  const canvas = root.querySelector<HTMLElement>(".whiteboard-canvas")!;
  const layer = root.querySelector<HTMLElement>(".object-layer")!;
  const presenceLayer = root.querySelector<HTMLElement>(".presence-layer")!;
  const edgeLayer = root.querySelector<HTMLElement>(".edges")!;
  const targetInput = root.querySelector<HTMLSelectElement>("#connection-target")!;
  const branchInput = root.querySelector<HTMLInputElement>("#connection-label")!;
  const edgeLabel = root.querySelector<HTMLInputElement>("#edge-label")!;
  const connectionList = root.querySelector<HTMLElement>("#connection-list")!;
  const svg = (tag: string) => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const textInput = root.querySelector<HTMLTextAreaElement>("#object-text")!;
  const colorInput = root.querySelector<HTMLSelectElement>("#object-color")!;
  const widthInput = root.querySelector<HTMLInputElement>("#object-width")!;
  const heightInput = root.querySelector<HTMLInputElement>("#object-height")!;
  canvas.style.width = `${canvasSize.width}px`;
  canvas.style.height = `${canvasSize.height}px`;
  for (const color of colors) {
    const option = document.createElement("option");
    option.value = color;
    option.textContent = color[0].toUpperCase() + color.slice(1);
    colorInput.append(option);
  }
  const selected = () => items.find(item => item.id === selectedId);
  const validPoint = (point: { x: any; y: any; }) => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= canvasSize.width && point.y <= canvasSize.height;
  const worldPoint = (event: { clientX: number; clientY: number; }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  };
  function publish() {
    clearTimeout(presenceTimer);
    presenceTimer = undefined;
    if (disposed) return;
    lastPresenceAt = performance.now();
    room.awareness.setLocalStateField("flowchart", { cursor, selectedId,
      drag: drag?.moved ? { id: drag.id, ...drag.position } : null });
  }
  function schedulePresence() {
    if (presenceTimer !== undefined) return;
    const remaining = 60 - (performance.now() - lastPresenceAt);
    if (remaining <= 0) publish();
    else presenceTimer = setTimeout(publish, remaining);
  }
  function select(id: string|null|undefined) {
    connecting = false;
    selectedEdgeId = null;
    selectedId = id ?? null;
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
  function setZoom(value: number) {
    cancelDrag();
    const center = { x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom };
    zoom = Math.min(1.5, Math.max(0.5, value));
    canvas.style.transform = `scale(${zoom})`;
    sizer.style.width = `${canvasSize.width * zoom}px`;
    sizer.style.height = `${canvasSize.height * zoom}px`;
    viewport.scrollLeft = center.x * zoom - viewport.clientWidth / 2;
    viewport.scrollTop = center.y * zoom - viewport.clientHeight / 2;
    root.querySelector<HTMLElement>("#zoom-level")!.textContent = `${Math.round(zoom * 100)}%`;
    root.querySelector<HTMLButtonElement>("#zoom-out")!.disabled = zoom <= 0.5;
    root.querySelector<HTMLButtonElement>("#zoom-in")!.disabled = zoom >= 1.5;
    cursor = null;
    publish();
  }
  on(root.querySelector<HTMLButtonElement>("#zoom-in")!, "click", () => setZoom(zoom + 0.25));
  on(root.querySelector<HTMLButtonElement>("#zoom-out")!, "click", () => setZoom(zoom - 0.25));
  on(root.querySelector<HTMLButtonElement>("#zoom-reset")!, "click", () => setZoom(1));
  root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach(button => on(button, "click", () => {
    if (readOnly) return;
    cancelDrag();
    const columns = Math.max(1, Math.floor(viewport.clientWidth / zoom / 260));
    const index = model.list().length;
    const id = model.add(button.dataset.add, { x: viewport.scrollLeft / zoom + 50 + index % columns * 260,
      y: viewport.scrollTop / zoom + 60 + Math.floor(index / columns) % 3 * 230 });
    select(id);
    textInput.focus();
    textInput.select();
    announce("Node added.");
  }));
  on(viewport, "pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const edge = (event.target as Element).closest<HTMLElement>("[data-edge-id]");
    if (edge) { selectEdge(edge.dataset.edgeId!); return; }
    const node = (event.target as Element).closest<HTMLElement>(".whiteboard-object");
    if (connecting && node && !readOnly) {
      event.preventDefault();
      completeConnection(node.dataset.objectId!);
      return;
    }
    if (!node) { select(null); return; }
    event.preventDefault();
    node.focus({ preventScroll: true });
    select(node.dataset.objectId!);
    const item = selected();
    if (readOnly || !item) return;
    const point = worldPoint(event);
    drag = { id: item.id, pointerId: event.pointerId, start: point, original: item.position,
      position: item.position, size: item.size, moved: false };
    viewport.setPointerCapture(event.pointerId);
  });
  on(viewport, "pointermove", (event) => {
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
  on(viewport, "pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const completed = drag;
    drag = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (!readOnly && completed.moved) {
      model.move(completed.id, completed.position);
      announce("Node moved.");
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
  on(viewport, "click", (event) => {
    const node = (event.target as Element).closest<HTMLElement>(".whiteboard-object");
    if (node && event.detail === 0) {
      if (connecting && !readOnly) completeConnection(node.dataset.objectId!);
      else select(node.dataset.objectId!);
    }
  });
  on(root, "keydown", (event) => {
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
    if (event.target !== viewport && !(event.target as Element).closest<HTMLElement>(".whiteboard-object")) return;
    if (selectedEdgeId && ["Delete", "Backspace"].includes(event.key)) {
      event.preventDefault(); model.disconnect(selectedEdgeId); return;
    }
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
  for (const [input, field] of [[textInput, "text"], [colorInput, "color"]] as const) {
    on(input, "focus", () => model.history.stopCapturing());
    on(input, "blur", () => model.history.stopCapturing());
    on(input, "input", () => { if (!readOnly && selectedId) model.edit(selectedId, field, input.value); });
  }
  for (const input of [widthInput, heightInput]) on(input, "change", () => {
    if (!readOnly && selectedId) model.resize(selectedId, { width: widthInput.valueAsNumber, height: heightInput.valueAsNumber });
    renderInspector();
  });
  on(root.querySelector<HTMLButtonElement>("#bring-front")!, "click", () => { if (!readOnly && selectedId) model.front(selectedId); });
  on(root.querySelector<HTMLButtonElement>("#delete-object")!, "click", () => { if (!readOnly && selectedId) model.remove(selectedId); });
  on(undo, "click", () => { if (!readOnly) { cancelDrag(); model.history.undo(); } });
  on(redo, "click", () => { if (!readOnly) { cancelDrag(); model.history.redo(); } });

  function selectEdge(id: string) {
    select(null);
    selectedEdgeId = id;
    render();
  }
  function completeConnection(target: string) {
    if (readOnly || !selectedId) return;
    if (target === selectedId) { announce("Choose a different node."); return; }
    const id = model.connect(selectedId, target, branchInput.value);
    if (id) { branchInput.value = ""; selectEdge(id); announce("Nodes connected."); }
  }
  on(root.querySelector<HTMLButtonElement>("#add-connection")!, "click", () => completeConnection(targetInput.value));
  on(root.querySelector<HTMLButtonElement>("#pick-target")!, "click", () => {
    if (readOnly) return;
    connecting = !connecting;
    renderInspector();
    if (connecting) { viewport.focus({ preventScroll: true }); announce("Choose the next node."); }
  });
  on(edgeLabel, "focus", () => model.history.stopCapturing());
  on(edgeLabel, "blur", () => model.history.stopCapturing());
  on(edgeLabel, "input", () => { if (!readOnly && selectedEdgeId) model.label(selectedEdgeId, edgeLabel.value); });
  on(root.querySelector<HTMLButtonElement>("#delete-connection")!, "click", () => { if (!readOnly && selectedEdgeId) model.disconnect(selectedEdgeId); });
  on(connectionList, "click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-edge-id]");
    if (button) selectEdge(button.dataset.edgeId!);
  });
  function scheduleEdges() {
    if (!disposed && edgeFrame === undefined) edgeFrame = requestAnimationFrame(paintEdges);
  }
  function paintEdges() {
    if (edgeFrame !== undefined) cancelAnimationFrame(edgeFrame);
    edgeFrame = undefined;
    if (disposed) return;
    const byId = new Map(items.map(item => [item.id, { ...item, position: painted.get(item.id) ?? item.position }]));
    for (const edge of model.connections()) {
      const pair = edgeNodes.get(edge.id);
      if (!pair) continue;
      const reverseId = JSON.stringify([edge.target, edge.source]);
      const geometry = connectionPath(byId.get(edge.source)!, byId.get(edge.target)!, { reciprocal: edgeNodes.has(reverseId) });
      for (const path of [pair.path, pair.hit]) path.setAttribute("d", geometry.path);
      pair.label.setAttribute("x", geometry.label.x);
      pair.label.setAttribute("y", geometry.label.y - 10);
    }
  }
  function syncConnections() {
    const edges = model.connections();
    const present = new Set(edges.map(edge => edge.id));
    for (const [id, pair] of edgeNodes) if (!present.has(id)) {
      pair.group.remove(); pair.button.parentElement.remove(); edgeNodes.delete(id);
    }
    const title = (id: string) => items.find(item => item.id === id)?.text || "Untitled";
    for (const edge of edges) {
      let pair = edgeNodes.get(edge.id);
      if (!pair) {
        const group = svg("g"), path = svg("path"), hit = svg("path"), label = svg("text");
        group.dataset.edgeId = edge.id;
        path.classList.add("flow-edge"); path.setAttribute("marker-end", "url(#flow-arrow)");
        hit.classList.add("flow-edge-hit"); label.classList.add("flow-edge-label");
        group.append(path, hit, label); edgeLayer.append(group);
        const li = document.createElement("li"), button = document.createElement("button");
        button.type = "button"; button.dataset.edgeId = edge.id; button.className = "subtle";
        li.append(button); connectionList.append(li);
        pair = { group, path, hit, label, button }; edgeNodes.set(edge.id, pair);
      }
      pair.group.classList.toggle("is-selected", selectedEdgeId === edge.id);
      pair.label.textContent = edge.label;
      pair.button.textContent = `${title(edge.source)} → ${title(edge.target)}${edge.label ? ` · ${edge.label}` : ""}`;
      pair.button.setAttribute("aria-pressed", String(selectedEdgeId === edge.id));
    }
    root.querySelector<HTMLElement>("#connections-empty")!.hidden = edges.length > 0;
    scheduleEdges();
  }

  function peers() {
    if (room.state.connection !== "connected") return [];
    return [...room.awareness.getStates()].filter(([id, state]) => id !== room.awareness.clientID && state.flowchart)
      .sort(([a], [b]) => a - b).map(([id, state]) => ({ id, ...state.flowchart,
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
      painted.delete(id);
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
      node.className = `whiteboard-object flow-node object-${item.kind} color-${item.color}`;
      node.classList.toggle("is-selected", selectedId === item.id);
      node.setAttribute("aria-pressed", String(selectedId === item.id));
      node.setAttribute("aria-label", `${kindLabel(item.kind)}: ${item.text || "Untitled"}`);
      if (!node.firstChild) node.append(document.createElement("span"));
      if (node.firstChild.textContent !== item.text) node.firstChild.textContent = item.text;
      Object.assign(node.style, { width: `${item.size.width}px`, height: `${item.size.height}px`, zIndex: String(index) });
    });
    root.querySelector<HTMLElement>(".canvas-empty")!.hidden = items.length > 0;
    const count = `${items.length} ${items.length === 1 ? "node" : "nodes"}`;
    if (root.querySelector<HTMLElement>("#object-count")!.textContent !== count) root.querySelector<HTMLElement>("#object-count")!.textContent = count;
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
      const remoteDrag = remote.findLast((peer: { drag: { id: string; x: number; y: number }; }) => peer.drag?.id === item.id && validPoint(peer.drag))?.drag;
      const preview = ownDrag && drag ? drag.position : remoteDrag;
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
          const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          arrow.setAttribute("viewBox", "0 0 28 28");
          arrow.setAttribute("aria-hidden", "true");
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", "M1.5 1.5 26.5 10.5 16 15 11 26.5Z");
          arrow.append(path);
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
    root.querySelector<HTMLElement>("#selection-fields")!.hidden = !item;
    root.querySelector<HTMLElement>("#selection-empty")!.hidden = Boolean(item || selectedEdgeId);
    root.querySelector<HTMLElement>("#edge-fields")!.hidden = !selectedEdgeId;
    const edge = model.connections().find(edge => edge.id === selectedEdgeId);
    if (edge && edgeLabel.value !== edge.label) edgeLabel.value = edge.label;
    edgeLabel.readOnly = readOnly;
    root.querySelector<HTMLButtonElement>("#delete-connection")!.disabled = readOnly;
    root.querySelector<HTMLButtonElement>("#pick-target")!.textContent = connecting ? "Cancel connection" : "Pick on canvas";
    root.querySelector<HTMLButtonElement>("#pick-target")!.setAttribute("aria-pressed", String(connecting));
    viewport.classList.toggle("is-connecting", connecting);
    root.querySelector<HTMLElement>("#canvas-help")!.textContent = connecting ? "Choose the next node · Escape to cancel" : "Scroll to explore · Select a node to edit or connect";
    if (!item) return;
    const previousTarget = targetInput.value;
    targetInput.replaceChildren(...items.filter(node => node.id !== item.id).map(node => {
      const option = document.createElement("option"); option.value = node.id; option.textContent = node.text || kindLabel(node.kind); return option;
    }));
    if ([...targetInput.options].some(option => option.value === previousTarget)) targetInput.value = previousTarget;
    for (const input of [targetInput, branchInput, root.querySelector<HTMLButtonElement>("#add-connection")!, root.querySelector<HTMLButtonElement>("#pick-target")!]) input.disabled = readOnly || !targetInput.options.length;
    root.querySelector<HTMLElement>("#selection-title")!.textContent = kindLabel(item.kind);
    if (textInput.value !== item.text) {
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      textInput.value = item.text;
      if (document.activeElement === textInput) textInput.setSelectionRange(Math.min(start, item.text.length), Math.min(end, item.text.length));
    }
    colorInput.value = item.color;
    widthInput.value = String(item.size.width);
    heightInput.value = String(item.size.height);
    textInput.readOnly = readOnly;
    for (const input of [colorInput, widthInput, heightInput, root.querySelector<HTMLButtonElement>("#bring-front")!, root.querySelector<HTMLButtonElement>("#delete-object")!]) input.disabled = readOnly;
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
      connecting = false;
      cancelDrag();
      publish();
      viewport.focus({ preventScroll: true });
      announce("The selected node was removed.");
    }
    if (selectedEdgeId && !model.connections().some(edge => edge.id === selectedEdgeId)) selectedEdgeId = null;
    syncObjects();
    syncConnections();
    scheduleActivity();
    renderInspector();
    renderHistory();
  }
  model.objects.observeDeep(render);
  model.edges.observeDeep(render);
  room.awareness.on("change", scheduleActivity);
  for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared", "stack-item-updated"] as const) model.history.on(event, renderHistory);
  setZoom(1);
  render();
  function destroy() {
    disposed = true;
    clearTimeout(presenceTimer);
    if (activityFrame !== undefined) cancelAnimationFrame(activityFrame);
    if (edgeFrame !== undefined) cancelAnimationFrame(edgeFrame);
    motion.destroy();
    peerNodes.clear();
    events.abort();
    model.objects.unobserveDeep(render);
    model.edges.unobserveDeep(render);
    room.awareness.off("change", scheduleActivity);
    model.destroy();
    nodes.clear();
    root.replaceChildren();
  }
  destroy.setReadOnly = (value: boolean) => {
    if (readOnly !== value) {
      readOnly = value;
      if (readOnly) { connecting = false; cancelDrag(); }
      root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach(button => { button.disabled = readOnly; });
      render();
    }
    scheduleActivity();
  };
  return destroy;
}
