import { Socket } from "phoenix";
import { PhoenixChannelProvider } from "y-phoenix-channel";
import * as Y from "yjs";
import { trackSaveStatus } from "./save-status.js";
import "./style.css";

const roomId = new URL(window.location.href).searchParams.get("room") ?? "demo";
const userId = crypto.randomUUID();
document.querySelector("#room").value = roomId;

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
const output = document.querySelector("#document");
const input = document.querySelector("#insert-text");
const stopSaveStatus = trackSaveStatus(doc, provider, (value) => {
  document.querySelector("#save-status").textContent = value;
});
let connected = false;
let connectionError = "";

function showStatus() {
  status.textContent = connectionError || (!connected
    ? "Disconnected"
    : provider.synced
      ? "Connected"
      : "Connecting");
}

async function connect() {
  connected = true;
  connectionError = "";
  connection.disabled = true;
  connection.textContent = "Disconnect";
  showStatus();

  try {
    const response = await fetch("/api/demo/room-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, user_id: userId }),
    });
    if (!response.ok) {
      throw new Error(response.status === 422 ? "Invalid room ID" : "Demo access unavailable");
    }
    const { token } = await response.json();
    provider.params.token = token;
    socket.connect();
    provider.connect();
  } catch (error) {
    connected = false;
    connectionError = error.message;
    connection.textContent = "Connect";
    showStatus();
  } finally {
    connection.disabled = false;
  }
}

provider.on("status", showStatus);
provider.on("sync", showStatus);
text.observe(() => {
  output.value = text.toString();
});

document.querySelector("#insert-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (input.value) {
    text.insert(0, input.value);
    input.value = "";
  }
});

document.querySelector("#delete-first").addEventListener("click", () => {
  const first = Array.from(text.toString())[0];
  if (first) text.delete(0, first.length);
});

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
  stopSaveStatus();
  provider.destroy();
  socket.disconnect();
  doc.destroy();
});

connect();
