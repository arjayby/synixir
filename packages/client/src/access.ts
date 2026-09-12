import type { RoomOptions } from "./types.js";
export class SynixirError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, { retryable = false }: { retryable?: boolean } = {}) {
    super(code);
    this.name = "SynixirError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeError(error: unknown) {
  if (error instanceof SynixirError) return error;
  return new SynixirError((error instanceof Error ? error.name : undefined) === "TimeoutError" ? "timeout" : "network_error", { retryable: true });
}

export function sessionAccess(serverUrl: URL, userId: string): NonNullable<RoomOptions["getAccess"]> {
  return async ({ roomId, signal }) => {
    async function request(path: string, options: RequestInit = {}) {
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
