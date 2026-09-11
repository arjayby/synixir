const colors = ["#3565b0", "#9a4626", "#7a4daa", "#26735b", "#aa3864", "#74601b"];

export function showParticipants(room, username, { avatars = false } = {}) {
  const awareness = room.awareness;
  const list = document.querySelector("#participants");
  const count = document.querySelector("#participant-count");
  const color = colors[awareness.clientID % colors.length];
  const name = username;
  awareness.setLocalStateField("user", { name, color, colorLight: `${color}26` });
  document.querySelector("#your-name").textContent = name;

  function render() {
    const online = room.state.connection === "connected";
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
      if (avatars) {
        dot.classList.add("participant-avatar");
        dot.textContent = label.textContent.slice(0, 2).toUpperCase();
      }
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

  awareness.on("change", render);
  const unsubscribe = room.subscribe(render);

  return () => {
    awareness.off("change", render);
    unsubscribe();
  };
}
