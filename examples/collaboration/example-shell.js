import { SynixirRoom } from "@synixir/client";
import { showParticipants } from "./presence.js";
import "./style.css";

export function startExample({ createSurface, pagePath = "/", presenceOptions }) {
  const roomId = new URL(window.location.href).searchParams.get("room");
  let csrf;
  let clearCollaboration = () => {};
  let hasUnsavedChanges = () => false;

  async function api(path, { method = "GET", body } = {}) {
    const response = await fetch(path, {
      method, credentials: "same-origin", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "request_failed");
    if (result.csrf_token) csrf = result.csrf_token;
    return result;
  }

  function explain(error) {
    return {
      invalid_credentials: "Username or password is incorrect.",
      invalid_registration: "Choose an available username and a password of 15–128 characters.",
      rate_limited: "Too many attempts. Wait a minute and try again.",
      unauthorized: "Access expired or denied",
      forbidden: "Only an owner can manage room access.",
      last_owner: "Add another owner before removing or changing the last owner.",
      room_unavailable: "That room ID is unavailable. Choose another.",
      room_quota: "This account has reached its room ownership limit. Ask an operator to review the limit.",
      account_not_found: "No account has that username.",
    }[error.message] ?? "The request failed. Please try again.";
  }

  function sessionChanged() {
    try { localStorage.setItem("synixir:session-change", crypto.randomUUID()); } catch { /* Storage may be disabled. */ }
  }
  window.addEventListener("storage", event => {
    if (event.key === "synixir:session-change") {
      clearCollaboration();
      window.location.reload();
    }
  });

  document.querySelector("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const path = event.submitter.value === "register" ? "/api/accounts" : "/api/session";
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach(button => button.disabled = true);
    try {
      await api(path, { method: "POST", body: values });
      sessionChanged();
      window.location.reload();
    } catch (error) {
      document.querySelector("#account-error").textContent = explain(error);
      buttons.forEach(button => button.disabled = false);
    }
  });

  document.querySelector("#sign-out").addEventListener("click", async () => {
    if (hasUnsavedChanges() && !window.confirm("Sign out and discard unsaved changes? Copy your draft first if you need it.")) return;
    try {
      await api("/api/session", { method: "DELETE" });
      clearCollaboration();
      sessionChanged();
      window.location.reload();
    } catch (error) { document.querySelector("#account-error").textContent = explain(error); }
  });

  document.querySelector("#create-room-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const { data } = await api("/api/rooms", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      window.location.href = `${pagePath}?room=${encodeURIComponent(data.id)}`;
    } catch (error) { document.querySelector("#account-error").textContent = explain(error); }
  });

  async function boot() {
    try {
      const { user } = await api("/api/session");
      document.querySelector("#auth-panel").hidden = Boolean(user);
      document.querySelector("#account-bar").hidden = !user;
      if (!user) return;
      document.querySelector("#account-name").textContent = user.username;
      if (roomId) {
        document.querySelector("#collaboration").hidden = false;
        startCollaboration(user);
      } else {
        document.querySelector("#rooms-panel").hidden = false;
        const { data } = await api("/api/rooms");
        document.querySelector("#room-list").replaceChildren(...data.map(room => {
          const item = document.createElement("li");
          const link = document.createElement("a");
          link.href = `${pagePath}?room=${encodeURIComponent(room.id)}`;
          link.textContent = `${room.id} · ${room.role}`;
          item.append(link);
          return item;
        }));
      }
    } catch (error) { document.querySelector("#account-error").textContent = explain(error); }
  }
  document.querySelectorAll("[data-room-home]").forEach(link => { link.href = pagePath; });
  if (roomId) document.querySelectorAll("#other-example, [data-example-link]").forEach(link => {
    link.href += `?room=${encodeURIComponent(roomId)}`;
  });
  void boot();

  function startCollaboration(user) {
    document.querySelector("#room").value = roomId;
    document.querySelector("#document-title").textContent = roomId;

    const room = new SynixirRoom({ roomId, userId: user.id });
    const status = document.querySelector("#status");
    const connection = document.querySelector("#connection");
    const stopParticipants = showParticipants(room, user.username, presenceOptions);
    const destroySurface = createSurface(room);
    let unsaved = false;
    const saveErrors = {
      storage_quota: "This room has reached its storage limit. Keep this tab open or copy your draft, and ask an operator for more space before retrying.",
      message_too_large: "This update exceeds the transfer limit. Keep this tab open and reduce the size of your changes before retrying.",
      rate_limited: "Too many updates at once. Wait a moment, then disconnect and connect to retry. Keep this tab open.",
      invalid_message: "The server rejected this update. Keep this tab open so your draft remains available.",
      timeout: "The save acknowledgement did not arrive. Disconnect and connect again to confirm your edits. Keep this tab open.",
    };
    function renderSave(value, reason) {
      const saveStatus = document.querySelector("#save-status");
      saveStatus.textContent = value;
      saveStatus.dataset.state = value === "Saved" ? "saved" : value === "Save failed" ? "failed" : "unsaved";
      unsaved = ["Saving", "Unsaved changes", "Save failed"].includes(value);
      document.querySelector("#save-help").textContent = value === "Save failed"
        ? saveErrors[reason] ?? "Save could not be confirmed. Disconnect and connect again to retry. Keep this tab open."
        : unsaved ? "Keep this tab open until Saved appears. Offline edits stay in this tab until you reconnect."
          : "Saved edits stay in this room after everyone leaves.";
    }
    const saveLabels = { "not-saved": "Not saved", saving: "Saving", saved: "Saved",
      unsaved: "Unsaved changes", failed: "Save failed", "view-only": "View only" };
    const connectionLabels = { connected: "Connected", connecting: "Connecting",
      reconnecting: "Reconnecting", disconnected: "Disconnected" };
    const connectionErrors = {
      node_channel_quota: "The server has reached its connection limit. Keep your draft and try again later.",
      room_channel_quota: "This room has reached its participant limit. Keep your draft and try again later.",
      account_channel_quota: "Too many room tabs are open for this account. Disconnect another tab before retrying.",
      document_quota: "The server has reached its active document limit. Keep your draft and try again later.",
    };
    let disposed = false;
    let previousRole;
    let checkedRevocation = false;
    let stopState = () => {};
    stopState = room.subscribe(state => {
      if (disposed) return;
      renderSave(saveLabels[state.saveStatus], state.saveError);
      unsaved = state.hasUnsavedChanges;
      destroySurface.setReadOnly(state.readOnly);
      document.querySelector("#role-label").textContent = state.role ?? "";
      document.querySelector("#members-panel").hidden = state.role !== "owner";
      if (state.role === "owner" && previousRole !== state.role) void loadMembers();
      previousRole = state.role;
      const frozen = ["access_changed", "account_changed"].includes(state.error?.code);
      const active = ["connecting", "connected", "reconnecting"].includes(state.connection);
      connection.textContent = frozen ? "Reload" : active ? "Disconnect" : "Connect";
      connection.disabled = false;
      status.textContent = connectionLabels[state.connection] ??
        (frozen ? "Access changed. Reload to check permissions."
          : state.error?.code === "unauthorized" ? "Access expired or denied"
            : state.error?.code === "timeout" ? "Connection timed out"
              : connectionErrors[state.error?.code] ?? "Document sync failed. Keep this tab open.");
      status.dataset.state = state.connection === "error" ? "error"
        : state.connection === "connected" ? "connected" : active ? "connecting" : "disconnected";
      if (state.error?.code === "account_changed") {
        clearCollaboration();
        window.location.reload();
      } else if (frozen && !checkedRevocation) {
        checkedRevocation = true;
        void checkRevokedSession();
      }
    });

    // Connection errors are rendered by the subscription. Network failures also
    // recover automatically; the button permits explicit disconnect/retry.
    function connect() { void room.connect().catch(() => {}); }
    connection.addEventListener("click", () => {
      if (["access_changed", "account_changed"].includes(room.state.error?.code)) return window.location.reload();
      if (["connecting", "connected", "reconnecting"].includes(room.state.connection)) void room.disconnect();
      else connect();
    });

    function dispose() {
      if (disposed) return;
      disposed = true;
      stopState();
      stopParticipants();
      destroySurface();
      void room.destroy();
    }
    window.addEventListener("pagehide", dispose);
    clearCollaboration = () => {
      unsaved = false;
      dispose();
      document.querySelector("#editor").replaceChildren();
      document.querySelector("#participants").replaceChildren();
      document.querySelector("#collaboration").hidden = true;
    };
    hasUnsavedChanges = () => unsaved;

    async function checkRevokedSession() {
      try {
        const session = await api("/api/session");
        if (session.user?.id !== user.id) {
          clearCollaboration();
          window.location.reload();
        }
      } catch { /* Keep the revoked draft available to copy. */ }
    }

    async function loadMembers() {
      try {
        const { data } = await api(`/api/rooms/${encodeURIComponent(roomId)}/members`);
        document.querySelector("#members-list").replaceChildren(...data.map(member => {
          const item = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = member.username;
          const select = document.createElement("select");
          select.setAttribute("aria-label", `Role for ${member.username}`);
          for (const role of ["owner", "editor", "viewer"]) {
            const option = document.createElement("option");
            option.value = role;
            option.textContent = role;
            select.append(option);
          }
          select.value = member.role;
          select.addEventListener("change", () => changeMember(member.username, select.value));
          const remove = document.createElement("button");
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", `Remove ${member.username}`);
          remove.addEventListener("click", () => changeMember(member.username, null));
          item.append(label, select, remove);
          return item;
        }));
      } catch (error) { document.querySelector("#member-error").textContent = explain(error); }
    }
    async function changeMember(username, nextRole) {
      try {
        await api(`/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(username)}`, {
          method: nextRole ? "PUT" : "DELETE", body: nextRole ? { role: nextRole } : undefined,
        });
        document.querySelector("#member-error").textContent = "";
        await loadMembers();
      } catch (error) { document.querySelector("#member-error").textContent = explain(error); }
    }
    document.querySelector("#member-form").addEventListener("submit", event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      void changeMember(values.get("username"), values.get("role"));
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
  }

}
