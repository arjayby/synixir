import { SynixirRoom } from "@synixir/client";

// A second consumer: no editor binding or knowledge of Phoenix channel events.
export let room;
const input = document.querySelector("#sdk-title");
const button = document.querySelector("#sdk-connection");
const status = document.querySelector("#sdk-state");
const roomId = new URL(location.href).searchParams.get("room");
let dispose = () => {};

try {
  const { user } = await (await fetch("/api/session", { signal: AbortSignal.timeout(10_000) })).json();
  if (!user || !roomId) throw new Error("Sign in and provide a room in the URL.");
  room = new SynixirRoom({ roomId, userId: user.id });
  const settings = room.doc.getMap("settings");
  room.awareness.setLocalStateField("page", "settings");
  const renderTitle = () => { input.value = settings.get("title") ?? ""; };
  settings.observe(renderTitle);
  const unsubscribe = room.subscribe(state => {
    input.disabled = state.readOnly;
    status.textContent = `${state.connection} · ${state.saveStatus}${state.error ? ` · ${state.error.code}` : ""}`;
    button.disabled = state.connection === "destroyed";
    button.textContent = ["connecting", "connected", "reconnecting"].includes(state.connection) ? "Disconnect" : "Connect";
    if (state.error?.code === "account_changed") {
      dispose();
      input.value = "";
    }
  });
  input.addEventListener("input", () => { if (!room.state.readOnly) settings.set("title", input.value); });
  button.addEventListener("click", () => {
    if (button.textContent === "Disconnect") void room.disconnect();
    else void room.connect().catch(() => {});
  });
  dispose = () => {
    unsubscribe();
    settings.unobserve(renderTitle);
    input.disabled = true;
    button.disabled = true;
    void room.destroy();
  };
  await room.connect().catch(() => {});
} catch (error) {
  status.textContent = error.message;
}

window.addEventListener("pagehide", () => dispose());
window.addEventListener("storage", event => {
  if (event.key === "synixir:session-change") {
    dispose();
    input.value = "";
    location.reload();
  }
});
