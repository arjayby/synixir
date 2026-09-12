export interface User {
  id: string;
  username: string;
}
export interface Session {
  user: User | null;
  csrf_token: string;
}
export interface Member {
  username: string;
  role: "owner" | "editor" | "viewer";
}
export interface RoomSummary {
  id: string;
  role: string;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (method !== "GET") {
    const session = await api<Session>("/api/session", "GET", undefined, signal);
    headers["x-csrf-token"] = session.csrf_token;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    signal: signal ?? AbortSignal.timeout(10_000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "request_failed");
  return result as T;
}
const messages: Record<string, string> = {
  invalid_credentials: "Username or password is incorrect.",
  invalid_registration: "Choose an available username and a password of 15–128 characters.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  unauthorized: "Access expired or denied",
  forbidden: "Only an owner can manage room access.",
  last_owner: "Add another owner before removing or changing the last owner.",
  room_unavailable: "That room ID is unavailable. Choose another.",
  room_quota:
    "This account has reached its room ownership limit. Ask an operator to review the limit.",
  account_not_found: "No account has that username.",
};
export function explain(error: unknown) {
  return (
    messages[error instanceof Error ? error.message : ""] ?? "The request failed. Please try again."
  );
}
export function sessionChanged() {
  try {
    localStorage.setItem("synixir:session-change", crypto.randomUUID());
  } catch {
    /* Storage may be disabled. */
  }
}
