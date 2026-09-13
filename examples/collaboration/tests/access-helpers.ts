import { request, expect, Page, APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

export const password = "a browser test password of sufficient length";
const rooms = new Map();

export async function changeConnection(page: Page, action: "Connect" | "Disconnect" | "Reload") {
  await page.getByRole("button", { name: "Connection status", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Connection status", exact: true });
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function api(context: APIRequestContext, baseURL: string|undefined, path: string, method = "GET", data?: { username?: string; password?: string; room_id?: string|null; role?: any; }) {
  const bootstrap = await context.get(`${baseURL}/api/session`);
  const session = await bootstrap.json();
  const response = await context.fetch(`${baseURL}${path}`, {
    method, data, headers: { "x-csrf-token": session.csrf_token },
  });
  return response;
}

export async function register(context: APIRequestContext, baseURL: string|undefined, username = `user_${randomUUID().replaceAll("-", "").slice(0, 20)}`) {
  const response = await api(context, baseURL, "/api/accounts", "POST", { username, password });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).user;
}

// Legacy collaboration scenarios now run through actual accounts and membership
// APIs. No test-only issuer or authentication bypass exists in the application.
export async function openRoom(page: Page, url: string|URL) {
  const baseURL = new URL(url).origin;
  const room = new URL(url).searchParams.get("room");
  let session = await (await page.request.get(`${baseURL}/api/session`)).json();
  const user = session.user ?? await register(page.request, baseURL);
  if (!rooms.has(room)) {
    rooms.set(room, (async () => {
      const owner = await request.newContext();
      await register(owner, baseURL);
      const created = await api(owner, baseURL, "/api/rooms", "POST", { room_id: room });
      expect(created.ok(), await created.text()).toBe(true);
      return { owner, users: new Set() };
    })());
  }
  const record = await rooms.get(room);
  if (!record.users.has(user.id)) {
    const granted = await api(record.owner, baseURL, `/api/rooms/${room}/members/${user.username}`, "PUT", { role: "editor" });
    expect(granted.ok(), await granted.text()).toBe(true);
    record.users.add(user.id);
  }
  return page.goto(String(url));
}
