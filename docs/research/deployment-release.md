# Deployment and release research

Researched on 2026-09-09 against `95e5580`, Phoenix 1.8.13, Elixir 1.18.3, OTP 27.3.3, Yex 0.10.5, and Argon2 Elixir 4.1.3. The selected target is local Docker staging. Use a production Mix release, one application node, its own PostgreSQL volume, and nginx terminating HTTPS on a loopback-only published port. Cloud hosting, public certificates, off-machine backups, and alert delivery are outside this rehearsal.

## Build one release for each target architecture

Use the Phoenix release template's separate builder and runner stages, with Debian Bookworm in both. Install `build-essential` and `git` in the builder. The runner needs the release plus `libstdc++6`, `openssl`, `libncurses6`, `locales`, and `ca-certificates`. Run as an unprivileged user and send the final command through `exec` so shutdown signals reach BEAM. The pinned template recommends matching Debian versions to avoid native-library incompatibilities. Source: [Phoenix 1.8.13 Docker template](https://github.com/phoenixframework/phoenix/blob/v1.8.13/priv/templates/phx.gen.release/Dockerfile.eex).

Docker Hub tag metadata confirmed these image-index digests and both `linux/amd64` and `linux/arm64` manifests. These checks establish available artifacts, not successful application execution inside them.

| Purpose | Image tag | Image-index digest |
| --- | --- | --- |
| BEAM builder | `hexpm/elixir:1.18.3-erlang-27.3.3-debian-bookworm-20260610-slim` | `sha256:74cb9d70a6eb64b6c22c2faba3702bb8afdf09408100f692c6b47025336c6a64` |
| BEAM runner | `debian:bookworm-20260610-slim` | `sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716` |
| Frontend builder | `node:24.12.0-bookworm-slim` | `sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99` |
| Database | `postgres:17.11-bookworm` | `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` |
| HTTPS gateway | `nginx:1.30.4-trixie` | `sha256:d5792f71a9496b833bc08ea834a758c46e2b6a6306c10f4be926f38a656cdc1c` |

Primary metadata: [Elixir tag](https://hub.docker.com/v2/repositories/hexpm/elixir/tags/1.18.3-erlang-27.3.3-debian-bookworm-20260610-slim), [Debian tag](https://hub.docker.com/v2/repositories/library/debian/tags/bookworm-20260610-slim), [Node tag](https://hub.docker.com/v2/repositories/library/node/tags/24.12.0-bookworm-slim), [PostgreSQL tag](https://hub.docker.com/v2/repositories/library/postgres/tags/17.11-bookworm), [nginx tag](https://hub.docker.com/v2/repositories/library/nginx/tags/1.30.4-trixie). Pin `tag@sha256:...` and record the resulting application image ID. nginx runs in a separate container, so its Debian version need not match BEAM's. Base digests alone do not make `apt-get`, Hex bootstrap, or every build input immutable; record package versions and rebuild deliberately for updates.

Yex's packaged checksum map includes GNU/Linux NIF 2.15 artifacts for both CPU architectures. RustlerPrecompiled selects and verifies the artifact at compilation. Argon2's `elixir_make` compiler builds its C NIF from the bundled reference implementation. Sources: [Yex checksum map](../../deps/y_ex/checksum-Elixir.Yex.Nif.exs), [Yex loader](../../deps/y_ex/lib/nif.ex), [Argon2 Makefile](../../deps/argon2_elixir/Makefile). OTP checks NIF API compatibility at load time, but that does not validate CPU architecture or available shared libraries. Source: [Erlang NIF version management](https://www.erlang.org/doc/apps/erts/erl_nif.html).

Exclude host `_build`, `deps`, `node_modules`, local secrets, backups, and `.git` from the Docker build context. Compile BEAM and its NIFs on each target platform. Do not pin that builder to `$BUILDPLATFORM` and then copy its native output into a different target architecture. Docker supports native builders or emulation; emulated builds can be much slower. Source: [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/).

Inside every final target image, run a release `eval` smoke check that creates and edits a Yex document, merges and reapplies an update, and hashes/verifies an Argon2 password. Report the tested platform explicitly. A successful macOS test or manifest inspection cannot substitute for this check. Keep runtime secrets in `runtime.exs`, enable the server with `PHX_SERVER=true`, and give the application an explicit HTTPS public origin. Mix releases include ERTS by default and require compatible operating-system and architecture builds. Source: [Elixir 1.18.3 release implementation and guidance](https://github.com/elixir-lang/elixir/blob/v1.18.3/lib/mix/lib/mix/tasks/release.ex).

Local AMD64 emulation reproduced a Mix error loading `MIME.Mixfile`: an attribute
write incorrectly targeted the already compiled `Synixir.MixProject`. Repeating
`mix deps.compile` in a clean dependency image failed, while compiling MIME alone
passed. Changing only `ERL_FLAGS` to `+JMsingle true` made the complete dependency
compilation pass. This supports a JIT/emulation mapping issue rather than corrupt
dependency source. OTP documents this flag for emulators that cannot handle dual
mapping. The Dockerfile exposes it as an optional build argument and keeps the
native runtime default. Source: [OTP 27 JIT memory mapping](https://www.erlang.org/docs/27/apps/erts/erl_cmd.html#%2BJMsingle).

## Serve the frontend from the release

Build the existing npm workspace with its lockfile and copy the Vite `dist` output into `priv/static` before assembling the release. The runtime image does not need Node or Vite. `vite preview` is a development preview server, not a production serving strategy. Source: [Vite deployment guidance](https://vite.dev/guide/static-deploy).

At the baseline, copying files alone is insufficient. `SynixirWeb.static_paths/0` excludes `index.html` and `sdk.html`, and the router has no root page route. `Plug.Static` does not automatically serve a directory index. Add deliberate routes for `/` and the SDK page, and serve their HTML with revalidation or `no-store`. Hashed Vite assets can use long immutable caching. Keep API and socket paths outside any HTML fallback. Sources: [web configuration](../../lib/synixir_web.ex), [router](../../lib/synixir_web/router.ex), [Plug.Static implementation](../../deps/plug/lib/plug/static.ex).

One origin preserves the SDK's default session/CSRF flow and avoids adding credentialed CORS. The default access callback uses `credentials: "same-origin"`; simply hosting the frontend on another origin changes its authentication behavior. Source: [SDK access implementation](../../packages/client/src/access.ts). Serving files from nginx is possible, but packaging HTML and the API together makes image rollback and asset matching simpler for this milestone.

## Make nginx the only trusted ingress

Publish only a chosen loopback HTTPS port, such as `127.0.0.1:4443`. Application and PostgreSQL ports stay inside a staging-only Compose network. Use a separate project name and named volume; never extend the development Compose file in a way that reuses its database volume. Compose service names remain stable, but recreated containers can receive new IP addresses. Source: [Compose networking](https://docs.docker.com/compose/how-tos/networking/).

Generate a local certificate with SAN entries for `DNS:localhost` and `IP:127.0.0.1`. Keep its private key and generated environment file outside the image and git, with restrictive permissions. OpenSSL supports this through `req -x509` and `-addext`. Use the certificate explicitly with `curl --cacert` for verification; browser test-specific certificate handling does not prove public trust. Do not install a global trust root as part of initialization. Source: [OpenSSL certificate generation](https://docs.openssl.org/3.0/man1/openssl-req/).

The gateway should overwrite `X-Forwarded-Proto` with `https` and forward a validated canonical Host. If the application uses forwarded client IPs for authentication throttling, overwrite `X-Forwarded-For` with nginx's `$remote_addr`. Then enable `:x_forwarded_for` rewriting only in the configuration whose application port is private behind this gateway. The baseline otherwise sees nginx's IP for every authentication request. Plug explicitly requires proxies to strip and replace trusted forwarded headers. Sources: [Plug.RewriteOn](https://plug.hexdocs.pm/Plug.RewriteOn.html), [current session throttling](../../lib/synixir_web/controllers/session_controller.ex).

Keep production cookies `Secure`, `HttpOnly`, and `SameSite=Lax`, and preserve the API CSRF pipeline. Use an exact WebSocket origin allowlist such as `https://localhost:4443`. Phoenix's default `check_origin: true` compares only the hostname. An explicit list checks scheme and port too. Missing Origin headers remain accepted by Phoenix, so signed grants and database authorization remain necessary. Sources: [endpoint cookie options](../../lib/synixir_web/endpoint.ex), [Phoenix 1.8.13 origin checks](https://github.com/phoenixframework/phoenix/blob/v1.8.13/lib/phoenix/socket/transport.ex#L346).

Proxy WebSockets with HTTP/1.1 and explicit `Upgrade` and `Connection` headers. Set a read timeout longer than the heartbeat interval. nginx otherwise closes an upstream connection after 60 seconds without data. Source: [nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html). Include all common Host and forwarded-header declarations in every proxy location: defining any `proxy_set_header` in `/socket` stops inheritance of those declarations from the server block. Source: [nginx header inheritance](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

Use Docker DNS with nginx's `upstream ... server app:4000 resolve` and a shared upstream zone, or reload/recreate nginx after replacing the application container. A static upstream can retain the old address. Source: [nginx upstream resolution](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#resolve).

Stock nginx provides request-rate and concurrent-connection limits. Apply them to authentication requests and WebSocket handshakes, with explicit rejection statuses. They do not rate-limit individual messages after upgrade, so retain the application message budgets. `limit_conn` counts requests after complete headers arrive, not every raw TCP socket; header timeouts and worker connection limits remain separate. Sources: [request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html), [connection limiting](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html).

## Migrate once and replace one application node

Add a release migration entry point following Phoenix's `Ecto.Migrator.with_repo/2` pattern, invoked with `bin/synixir eval`. It loads application configuration and starts only the dependencies needed to migrate. Do not run `mix ecto.migrate` in a final image without Mix, or launch the full HTTP application merely to migrate. Source: [Phoenix release migration template](https://github.com/phoenixframework/phoenix/blob/v1.8.13/priv/templates/phx.gen.release/release.ex.eex).

For a fresh staging volume, wait for PostgreSQL health, run the migration container to successful completion, then start the application and gateway. Compose supports `service_healthy` and `service_completed_successfully` startup dependencies. These gates do not continuously supervise application readiness after startup. Source: [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).

For upgrades, record the previous image ID, preserve secrets, take a checked backup, stop admission through the gateway, gracefully stop the old application, run migrations, and start exactly one new application. Reopen traffic after readiness and a durable collaboration check. Use a shutdown grace period long enough for socket draining; Phoenix's socket drainer alone defaults to 30 seconds. Source: [Phoenix socket draining](https://github.com/phoenixframework/phoenix/blob/v1.8.13/lib/phoenix/endpoint.ex#L832).

Single-node ownership is a real constraint. Two overlapping releases can create separate in-memory owners for the same room. The local Registry and admission counters do not become globally unique merely by enabling DNSCluster. Do not claim rolling, zero-downtime upgrades for this design. Sources: [document supervision](../../lib/synixir/documents/supervisor.ex), [collaboration supervision](../../lib/synixir/collaboration_supervisor.ex).

Application rollback should select the previous tested image and retain the database when its schema remains compatible. Prefer additive migrations that keep this option open. A down migration or restoring an old backup can discard data and later revocations; neither should run automatically after a health failure. Keep the previous image and a written compatibility decision. The release-template rollback function is a mechanism, not proof that a particular migration is reversible. See [backup and restore requirements](production-readiness.md).

## Verify the assembled staging system

Keep `/metrics` unavailable through nginx even with a bearer token. Scrape it only from the private network with the configured token. Run liveness and readiness internally, preserving their database-independent and database-dependent meanings. Exclude only the required probe paths from SSL redirects for internal HTTP checks, or use the existing localhost exclusion deliberately. Source: [Plug.SSL exclusions](https://plug.hexdocs.pm/Plug.SSL.html). A bearer-protected route is still useful internally; private networking alone does not validate callers.

The rehearsal should prove the following against its own empty PostgreSQL volume and selected loopback port:

- Release boot, native-library smoke checks, migration success and harmless rerun.
- HTTPS HTML and assets, correct cookie flags, successful CSRF-protected login, and rejection of unsafe requests.
- Accepted canonical WebSocket origin, rejected wrong scheme/port, two SDK clients converging, and committed save status.
- App-container replacement with the same database restores accounts and documents, reconnects clients, and survives nginx upstream address changes.
- Database outage makes readiness fail while liveness remains available; restoring the staging database recovers readiness.
- Metrics remain hidden at ingress and require a token internally; quotas still reject excess joined channels.

Use the staging Compose file and project name explicitly for every operation. Stop and restart it without deleting its volume. Cleanup of disposable smoke resources must target only names created by that run. Do not touch development ports `4000` and `5173`, the development database container, or shared `synixir_test`. This research performed source and image-metadata reads only; it did not build, start, migrate, or deploy infrastructure.
