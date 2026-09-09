# Authentication and room permissions

Research dated 2026-09-09, using this checkout's Phoenix 1.8.13 implementation and primary sources. The implementation uses local public usernames and passwords. The account ID, session, membership, and revocation design can remain the same if an external identity provider is chosen.

## Accounts and sessions

Keep the JSON API and Vite client. Use Phoenix's authentication generator as a source for account and session behavior, without importing its HTML, LiveView, or email flows. Its password-hashing documentation recommends considering `argon2_elixir`, although its Unix default is bcrypt. Source: [Phoenix 1.8.13 authentication generator](https://github.com/phoenixframework/phoenix/blob/v1.8.13/lib/mix/tasks/phx.gen.auth.ex#L68).

For local passwords, use `Argon2.hash_pwd_salt/1`, `verify_pass/2`, and matching `no_user_verify/0` handling for unknown accounts. The current published package is 4.1.3 and defaults to Argon2id. Its `m_cost` is an exponent: the default `16` means 64 MiB. Keep reduced hashing parameters confined to tests and rate-limit login and registration before hashing. Sources: [Argon2 API](https://argon2-elixir.hexdocs.pm/Argon2.html), [parameter configuration](https://argon2-elixir.hexdocs.pm/Argon2.Stats.html), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Give each account a stable database ID. A proposed session contains 32 random bytes in the existing signed, HttpOnly session cookie, with a SHA-256 digest, account ID, and expiration in PostgreSQL. Look up that record on authenticated requests. The database record provides individual revocation; a signed cookie alone does not. Phoenix's generator uses the same random-token/database approach but stores its signed-cookie session token directly, so hashing the stored token is a deliberate design choice here. Source: [Phoenix session-token template](https://github.com/phoenixframework/phoenix/blob/v1.8.13/priv/templates/phx.gen.auth/schema_token.ex.eex).

Use host-only cookies with `SameSite=Lax`, `Path=/`, `HttpOnly`, and `Secure` under production HTTPS. Renew and clear the session on login/logout, rotate the CSRF token, and delete the durable session before reporting logout success. Phoenix's template also broadcasts a socket disconnect on logout. Source: [Phoenix authentication template](https://github.com/phoenixframework/phoenix/blob/v1.8.13/priv/templates/phx.gen.auth/auth.ex.eex#L60).

A locally registered email is not proof that the account controls that address. Without email verification, grant access to explicit account handles/IDs and avoid presenting addresses as verified identities. If OIDC is selected, map its issuer and subject to the internal account ID; email is not the stable identity key. Source: [OIDC claim stability and uniqueness](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).

## HTTP and WebSocket boundary

The existing endpoint installs `Plug.Session`, but the API pipeline only accepts JSON. Add session fetching and `Plug.CSRFProtection`. A JSON bootstrap endpoint can return the current account and `get_csrf_token/0` with `Cache-Control: no-store`. Send that token as `x-csrf-token` for login, registration, logout, room creation, and membership changes. Plug expressly recommends CSRF protection for session-authenticated JSON. Source: [Plug CSRF protection](https://plug.hexdocs.pm/Plug.CSRFProtection.html).

Proxy all `/api` routes and `/socket` through Vite so the browser uses relative same-origin URLs. Preserve the real WebSocket Origin. Vite does not validate proxied WebSocket origins, and its documentation warns that rewriting them bypasses target checks. Replace the current development `check_origin: false` with the exact allowed frontend origins, including the separate browser-test port. Source: [Vite proxy and WebSocket origin behavior](https://vite.dev/config/server-options#server-proxy).

The implementation retains bearer grants for room joins. HTTP cookie authentication
and CSRF protection gate issuance; the signed grant binds a database session and
membership version. The socket never treats an ambient cookie or an unsigned
user ID as identity. Each room join verifies the grant and current database state,
and logout closes channels subscribed to that session. A direct cookie-authenticated
socket would additionally need Phoenix's session connect-info and socket CSRF flow.
Sources: [Phoenix transport session handling](https://github.com/phoenixframework/phoenix/blob/v1.8.13/lib/phoenix/socket/transport.ex#L515),
[socket IDs and disconnects](https://phoenix.hexdocs.pm/Phoenix.Socket.html).

The unrestricted demo token endpoint must not remain an alternate route into authenticated rooms. Client-supplied user IDs, roles, and old room grants must never replace the current session and membership lookup.

## Membership and revocation

A minimal policy is:

| Action | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Join, receive document, query presence | Yes | Yes | Yes |
| Publish allowed ephemeral presence | Yes | Yes | Yes |
| Persist document updates | Yes | Yes | No |
| Grant, change, or revoke membership | Yes | No | No |

Keep one authoritative ownership representation and a unique membership per room/account. Room creation and the initial owner must commit together. Serialize membership administration so concurrent requests cannot remove the last owner or grant ownership inconsistently. Deny missing memberships by default.

The following write ordering is a design recommendation based on PostgreSQL locking guarantees:

1. In the document worker, begin a database transaction and lock/recheck the current session and membership before applying an update.
2. Hold those locks through applying Yex and committing the raw update.
3. Make logout, role changes, and membership revocation conflict with the same locks, in a consistent acquisition order.

A writer authorized first may finish before revocation commits. Once revocation commits, a stale queued call cannot authorize a new write. Shared row locks can conflict with membership/session updates or deletions; transaction-scoped advisory locks are another option. Source: [PostgreSQL row and advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html).

A channel-only check has a race with queued `GenServer.call` messages. A channel-process database transaction also does not extend its transaction into the document process. Put the authorization and persistence transaction at the actual mutation boundary. If commit fails after Yex changes, retain the current rule that stops the mutated worker before broadcasting.

After durable revocation, notify and close affected channels, clear partial chunk transfers, and invalidate future joins. PubSub notifications provide prompt cleanup; they cannot be the only authorization mechanism. Check current access before accepting chunks, again after assembly at the write boundary, and before forwarding queued document/awareness events. Expiring sessions need the same treatment. Messages already sent cannot be recalled. Source: [OWASP WebSocket session and message authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

## Viewer sync and browser state

The current server returns both a sync-step-2 response and a reverse sync-step-1 request. The provider answers that reverse request with the browser's local state. Separately, `save-status.js` uploads full state whenever synchronization completes. Those behaviors are writes even when the editor looks read-only. This follows from the current `document.ex`, `save-status.js`, and published provider implementation. Source: [y-phoenix-channel 0.3.0 package](https://registry.npmjs.org/y-phoenix-channel/-/y-phoenix-channel-0.3.0.tgz).

For viewers, return the server's sync-step-2 response without requesting a reverse update. Disable local editing, undo/redo, and automatic save tracking. Reject all decoded update messages server-side, including updates hidden inside `yjs`, `yjs_sync`, and assembled transfers. Awareness may remain allowed under the same membership check. Role downgrade should force a fresh connection using the new role.

On logout or account switch, destroy the old provider, chunk adapter, editor, undo manager, awareness, and Y.Doc; clear their DOM and abort pending fetches. Advance a generation so late account, room-token, transfer, and save callbacks cannot recreate the old session. Never reuse that Y.Doc for another account: its unsaved updates would otherwise be uploaded by the next full-state sync. Notify other tabs of auth changes without transmitting tokens, and revalidate their sessions. The existing back/forward-cache reload handling should remain.

Tests should cover forged identity and room IDs, every role/write path, CSRF and hostile WebSocket origins, persisted revocation across restart, revoke during chunk assembly, a queued write blocked until after revocation, viewer sync without uploads, and logout followed by a different account in the same browser.
