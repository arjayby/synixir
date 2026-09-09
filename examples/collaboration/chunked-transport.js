// Keeps the provider's Yjs protocol and Push.receive API intact. Only complete
// messages reach Yjs; partial uploads are never reported as durable saves.
const HEADER = 13;
const EVENTS = ["yjs", "yjs_sync", "save_update"];

function receipt() {
  let outcome;
  const callbacks = [];
  const result = {
    receive(status, callback) {
      callbacks.push({ status, callback });
      if (outcome?.status === status) callback(outcome.value);
      return result;
    },
    finish(status, value) {
      if (outcome) return;
      outcome = { status, value };
      for (const listener of callbacks) {
        if (listener.status === status) listener.callback(value);
      }
    },
  };
  return result;
}

export function chunkedSocket(socket) {
  return {
    endPointURL: () => socket.endPointURL(),
    channel: (topic, params) => adaptChannel(socket.channel(topic, { ...params, chunked_sync: 1 })),
  };
}

function adaptChannel(channel) {
  const push = channel.push.bind(channel);
  let limits;
  let generation = 0;
  let nextId = 0;
  let queue = [];
  let queuedBytes = 0;
  let running = false;
  let incoming;
  const pending = new Set();

  function clearIncoming() {
    clearTimeout(incoming?.timer);
    incoming = undefined;
  }

  function reset() {
    generation++;
    clearIncoming();
    queue = [];
    queuedBytes = 0;
    running = false;
    for (const result of pending) result.finish("error", { reason: "disconnected" });
    pending.clear();
  }

  channel.onError(reset);
  channel.onClose(reset);
  channel.joinPush.receive("ok", ({ transfer }) => {
    reset();
    limits = transfer;
  });

  function syncError(reason) {
    clearIncoming();
    channel.trigger("sync_error", { reason });
  }

  channel.on("yjs_chunk", buffer => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER || !limits) {
      return syncError("invalid_chunk");
    }
    const header = new DataView(buffer);
    const kind = header.getUint8(0);
    const id = header.getUint32(1);
    const offset = header.getUint32(5);
    const total = header.getUint32(9);
    const part = new Uint8Array(buffer, HEADER);
    if (kind !== 0 || total > limits.max_transfer_bytes || part.length > limits.chunk_bytes ||
        offset + part.length > total) return syncError("invalid_chunk");
    if (offset === 0) {
      clearIncoming();
      incoming = { id, total, offset: 0, data: new Uint8Array(total),
        timer: setTimeout(() => syncError("transfer_timeout"), limits.transfer_timeout_ms) };
    }
    if (!incoming || incoming.id !== id || incoming.total !== total || incoming.offset !== offset) {
      return syncError("invalid_chunk");
    }
    incoming.data.set(part, offset);
    incoming.offset += part.length;
    if (incoming.offset === total) {
      const complete = incoming.data.buffer;
      clearIncoming();
      channel.trigger("yjs", complete);
    }
  });

  function request(event, buffer, timeout) {
    return new Promise(resolve => {
      push(event, buffer, timeout)
        .receive("ok", value => resolve({ status: "ok", value }))
        .receive("error", value => resolve({ status: "error", value }))
        .receive("timeout", () => resolve({ status: "timeout", value: {} }));
    });
  }

  async function drain() {
    if (running) return;
    running = true;
    const current = generation;
    while (queue.length && current === generation) {
      const { event, buffer, timeout, result } = queue.shift();
      const id = nextId = (nextId + 1) >>> 0;
      const bytes = new Uint8Array(buffer);
      const deadline = Date.now() + limits.transfer_timeout_ms;
      let reply;
      for (let offset = 0; offset < bytes.length; offset += limits.chunk_bytes) {
        if (current !== generation) return;
        if (Date.now() >= deadline) {
          reply = { status: "timeout", value: {} };
          break;
        }
        const part = bytes.subarray(offset, offset + limits.chunk_bytes);
        const fragment = new Uint8Array(HEADER + part.length);
        const header = new DataView(fragment.buffer);
        header.setUint8(0, EVENTS.indexOf(event));
        header.setUint32(1, id);
        header.setUint32(5, offset);
        header.setUint32(9, bytes.length);
        fragment.set(part, HEADER);
        reply = await request("transfer_chunk", fragment.buffer, timeout);
        if (current !== generation) return;
        if (reply.status !== "ok") break;
        // Leave room for normal edits and awareness within the channel budget.
        if (offset + part.length < bytes.length) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (current !== generation) return;
      queuedBytes -= buffer.byteLength;
      pending.delete(result);
      result.finish(reply.status, reply.value);
    }
    if (current === generation) running = false;
  }

  channel.push = (event, buffer, timeout = 10_000) => {
    if (!EVENTS.includes(event) || !(buffer instanceof ArrayBuffer) ||
        !limits || buffer.byteLength <= limits.max_message_bytes) {
      const result = push(event, buffer, timeout);
      if (event === "yjs_sync") {
        const current = generation;
        result.receive("error", ({ reason }) => {
          if (current === generation) syncError(reason);
        }).receive("timeout", () => {
          if (current === generation) syncError("timeout");
        });
      }
      return result;
    }
    const result = receipt();
    if (event === "yjs_sync") {
      result.receive("error", ({ reason }) => {
        if (reason !== "disconnected") syncError(reason);
      })
        .receive("timeout", () => syncError("timeout"));
    }
    // The provider and save tracker may send the same update independently.
    // Bound the client queue too; an overflow leaves the edit unconfirmed.
    if (buffer.byteLength > limits.max_transfer_bytes ||
        queuedBytes + buffer.byteLength > 2 * limits.max_transfer_bytes) {
      result.finish("error", { reason: "message_too_large" });
      return result;
    }
    if (channel.state !== "joined") {
      result.finish("error", { reason: "disconnected" });
      return result;
    }
    queuedBytes += buffer.byteLength;
    pending.add(result);
    queue.push({ event, buffer, timeout, result });
    void drain();
    return result;
  };
  return channel;
}
