import { Socket } from "phoenix";
import { PhoenixChannelProvider } from "y-phoenix-channel";
import * as Y from "yjs";
import { trackSaveStatus } from "./save-status.js";
import { createEditor } from "./editor.js";
import { showParticipants } from "./presence.js";
import "./style.css";

const roomId = new URL(window.location.href).searchParams.get("room") ?? "demo";
const userId = crypto.randomUUID();
document.querySelector("#room").value = roomId;
document.querySelector("#document-title").textContent = roomId;

const doc = new Y.Doc();
const text = doc.getText("content");
const socket = new Socket("/socket");
const provider = new PhoenixChannelProvider(socket, `document:${roomId}`, doc, {
  connect: false,
  // Every update must go through Phoenix, including when using two local tabs.
  disableBc: true,
});

const status = document.querySelector("#status");
const connection = document.querySelector("#connection");
const stopParticipants = showParticipants(provider, userId);
const destroyEditor = createEditor(text, provider.awareness);
let unsaved = false;
const saveErrors = {
  message_too_large: "This update exceeds the server limit. Copy your text before leaving and use a smaller document.",
  rate_limited: "Too many updates at once. Wait a moment, then disconnect and connect to retry. Keep this tab open.",
  invalid_message: "The server rejected this update. Copy your text before leaving this tab.",
  timeout: "The save acknowledgement did not arrive. Disconnect and connect again to confirm your edits. Keep this tab open.",
};
const stopSaveStatus = trackSaveStatus(doc, provider, (value, reason) => {
  const saveStatus = document.querySelector("#save-status");
  saveStatus.textContent = value;
  saveStatus.dataset.state = value === "Saved" ? "saved" : value === "Save failed" ? "failed" : "unsaved";
  unsaved = ["Saving", "Unsaved changes", "Save failed"].includes(value);
  document.querySelector("#save-help").textContent = value === "Save failed"
    ? saveErrors[reason] ?? "Save could not be confirmed. Disconnect and connect again to retry. Keep this tab open."
    : unsaved ? "Keep this tab open until Saved appears. Offline edits stay in this tab until you reconnect."
      : "Saved edits stay in this room after everyone leaves.";
});
let connected = false;
let connectionError = "";
let hasConnected = false;
let transportStatus = "connecting";
let disposed = false;

function showStatus() {
  const synced = transportStatus === "connected" && provider.synced;
  status.textContent = connectionError || (!connected ? "Disconnected"
    : synced ? "Connected" : hasConnected ? "Reconnecting" : "Connecting");
  status.dataset.state = connectionError ? "error" : !connected ? "disconnected" : synced ? "connected" : "connecting";
  if (connected && synced) hasConnected = true;
}

async function connect() {
  connected = true;
  connectionError = "";
  transportStatus = "connecting";
  connection.disabled = true;
  connection.textContent = "Disconnect";
  showStatus();

  try {
    const response = await fetch("/api/demo/room-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, user_id: userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(response.status === 422 ? "Invalid room ID" : "Demo access unavailable");
    }
    const { token } = await response.json();
    if (disposed) return;
    provider.params.token = token;
    socket.connect();
    provider.connect();
    const channel = provider.channel;
    const rejectJoin = (message) => {
      if (provider.channel !== channel || disposed) return;
      connected = false;
      connectionError = message;
      provider.disconnect();
      socket.disconnect();
      connection.textContent = "Connect";
      showStatus();
    };
    // Phoenix reuses joinPush on automatic rejoin. Surface a rejected grant
    // instead of retrying the same expired token indefinitely.
    channel.joinPush.receive("error", ({ reason }) => rejectJoin(reason === "unauthorized"
      ? "Access expired or denied" : "Room unavailable"));
    channel.joinPush.receive("timeout", () => rejectJoin("Connection timed out"));
  } catch (error) {
    if (disposed) return;
    connected = false;
    connectionError = error.name === "TimeoutError" ? "Access request timed out" : error.message;
    connection.textContent = "Connect";
    showStatus();
  } finally {
    connection.disabled = false;
  }
}

provider.on("status", ({ status }) => { transportStatus = status; showStatus(); });
provider.on("sync", showStatus);

connection.addEventListener("click", () => {
  if (connected) {
    connected = false;
    provider.disconnect();
    socket.disconnect();
    connection.textContent = "Connect";
    showStatus();
  } else {
    connect();
  }
});

window.addEventListener("pagehide", () => {
  disposed = true;
  stopSaveStatus();
  stopParticipants();
  destroyEditor();
  provider.destroy();
  socket.disconnect();
  doc.destroy();
});

window.addEventListener("beforeunload", (event) => {
  if (unsaved) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// A page restored from the back/forward cache needs a fresh connection and editor.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

connect();
