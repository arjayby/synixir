import { Socket } from "phoenix";
import { PhoenixChannelProvider } from "y-phoenix-channel";
import * as Y from "yjs";
import "./style.css";

const doc = new Y.Doc();
const text = doc.getText("content");
const socket = new Socket("/socket");
const provider = new PhoenixChannelProvider(socket, "document:demo", doc, {
  connect: false,
  // Every update must go through Phoenix, including when using two local tabs.
  disableBc: true,
});

const status = document.querySelector("#status");
const connection = document.querySelector("#connection");
const output = document.querySelector("#document");
const input = document.querySelector("#insert-text");
let connected = true;

function showStatus() {
  status.textContent = !connected
    ? "Disconnected"
    : provider.synced
      ? "Connected"
      : "Connecting";
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

connection.addEventListener("click", () => {
  connected = !connected;
  if (connected) {
    socket.connect();
    provider.connect();
  } else {
    provider.disconnect();
    socket.disconnect();
  }
  connection.textContent = connected ? "Disconnect" : "Connect";
  showStatus();
});

window.addEventListener("pagehide", () => {
  provider.destroy();
  socket.disconnect();
  doc.destroy();
});

socket.connect();
provider.connect();
