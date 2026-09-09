import * as Y from "yjs";

// The standard provider handles synchronization. Explicit save requests let
// this example distinguish a database acknowledgement from a sync handshake.
export function trackSaveStatus(doc, provider, render) {
  let revision = 0;
  let confirmed = -1;
  let generation = 0;
  let failed = false;
  let failureReason = "";
  const acknowledged = new Set();

  function show() {
    const online = provider.synced && provider.channel?.state === "joined";
    render(confirmed >= revision ? "Saved"
      : failed ? "Save failed"
        : online ? "Saving"
          : revision > 0 ? "Unsaved changes" : "Not saved", failureReason);
  }

  function save(update, capturedRevision, fullState = false) {
    const channel = provider.channel;
    if (!provider.synced || channel?.state !== "joined") return show();
    const capturedGeneration = generation;
    const current = () => capturedGeneration === generation && provider.channel === channel;
    const failure = ({ reason = "save_unconfirmed" } = {}) => {
      if (current() && capturedRevision > confirmed) {
        failed = true;
        failureReason = reason;
        show();
      }
    };

    channel.push("save_update", update.slice().buffer, 10_000)
      .receive("ok", ({ saved }) => {
        if (!current()) return;
        if (!saved) return failure();
        if (fullState) confirmed = Math.max(confirmed, capturedRevision);
        else acknowledged.add(capturedRevision);
        while (acknowledged.delete(confirmed + 1)) confirmed++;
        for (const item of acknowledged) if (item <= confirmed) acknowledged.delete(item);
        if (confirmed >= revision) {
          failed = false;
          failureReason = "";
        }
        show();
      })
      .receive("error", failure)
      .receive("timeout", () => failure({ reason: "timeout" }));
    show();
  }

  function updated(update, origin) {
    if (origin !== provider) {
      revision++;
      save(update, revision);
    }
  }

  function synced(value) {
    generation++;
    acknowledged.clear();
    failed = false;
    failureReason = "";
    // A full update covers offline changes, including deletions, even if the
    // provider's initial handshake has not yet uploaded every local change.
    if (value) save(Y.encodeStateAsUpdate(doc), revision, true);
    show();
  }

  doc.on("update", updated);
  provider.on("sync", synced);
  provider.on("status", show);
  show();

  return () => {
    generation++;
    doc.off("update", updated);
    provider.off("sync", synced);
    provider.off("status", show);
  };
}
