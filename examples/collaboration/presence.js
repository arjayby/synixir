const colors = ["#3565b0", "#9a4626", "#7a4daa", "#26735b", "#aa3864", "#74601b"];

export function showParticipants(provider, username) {
  const awareness = provider.awareness;
  const list = document.querySelector("#participants");
  const count = document.querySelector("#participant-count");
  const color = colors[awareness.clientID % colors.length];
  const name = username;
  awareness.setLocalStateField("user", { name, color, colorLight: `${color}26` });
  document.querySelector("#your-name").textContent = name;

  function render() {
    const online = provider.shouldConnect && provider.synced && provider.channel?.state === "joined";
    const participants = [...awareness.getStates()]
      .filter(([id, state]) => state.user && (online || id === awareness.clientID))
      .sort(([a], [b]) => a === awareness.clientID ? -1 : b === awareness.clientID ? 1 : a - b);
    list.replaceChildren(...participants.map(([id, state]) => {
      const local = id === awareness.clientID;
      const item = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "participant-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : colors[0];
      const label = document.createElement("span");
      label.className = "participant-name";
      label.textContent = typeof state.user.name === "string" ? state.user.name.slice(0, 32) : "Guest";
      const detail = document.createElement("span");
      detail.className = "participant-detail";
      detail.textContent = local ? online ? "You" : "You · offline" : "Online";
      item.append(dot, label, detail);
      return item;
    }));
    const countLabel = online ? `${participants.length} online` : "Offline";
    // Cursor movement also triggers change; only announce actual count changes.
    if (count.textContent !== countLabel) count.textContent = countLabel;
  }

  function synced(value) {
    // Disconnect removes this client at its last awareness clock. Advance the
    // clock on every rejoin so peers accept the returning state immediately.
    if (value) awareness.setLocalState(awareness.getLocalState());
    render();
  }

  awareness.on("change", render);
  provider.on("status", render);
  provider.on("sync", synced);
  render();

  return () => {
    awareness.off("change", render);
    provider.off("status", render);
    provider.off("sync", synced);
  };
}
