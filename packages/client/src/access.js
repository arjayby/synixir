export class SynixirError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "SynixirError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeError(error) {
  if (error instanceof SynixirError) return error;
  return new SynixirError(error?.name === "TimeoutError" ? "timeout" : "network_error", { retryable: true });
}

export function sessionAccess(serverUrl, userId) {
  return async ({ roomId, signal }) => {
    async function request(path, options = {}) {
      const response = await fetch(new URL(path, serverUrl), {
        credentials: "same-origin", signal, ...options,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new SynixirError(result.error ?? "request_failed", {
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return response.json();
    }
    const session = await request("/api/session");
    if (session.user?.id !== userId) throw new SynixirError("account_changed");
    const { data } = await request(`/api/rooms/${encodeURIComponent(roomId)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": session.csrf_token },
    });
    return { token: data.token, userId: data.user_id, role: data.role };
  };
}
