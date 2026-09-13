# Local Docker staging

Step 11 packages the browser examples and Phoenix application in a production
release. The selected target is a local Docker installation with its own database,
HTTPS gateway and private Prometheus collector. It runs one application node.

## Start staging

Requirements: Docker with Compose v2, OpenSSL, and Elixir 1.18+ with Erlang/OTP 27+.
Use the versions pinned in `.tool-versions`. The standalone staging scripts use
only the Elixir and Erlang standard libraries, so they need no `mix deps.get`.
The browser pilot also needs Node.js matching `examples/collaboration/.nvmrc`.
Docker builds the application and frontend inside the image. Run these commands
from the repository:

```sh
elixir scripts/staging.exs init
elixir scripts/staging.exs build
elixir scripts/staging.exs up
elixir scripts/staging.exs status
```

Open [local staging](https://localhost:8443) and create an account. The generated certificate
is self-signed, so a browser requires a local certificate exception. The pilot
accepts this certificate only in its browser contexts. It does not install a
system trust root. For a verified command-line request:

```sh
curl --cacert .local/staging/localhost.crt https://localhost:8443/health/ready
```

Initialization creates a private `.local/staging` directory. Its `.env`, TLS key,
pilot credentials and backups are ignored by Git and must stay private. Retain
the `.env` with the database volume: its session secret, application password and
release cookie must survive replacements. Initialization refuses an existing
directory or Compose project rather than rotating its credentials. The certificate
expires after 30 days. To renew it, stop staging, regenerate the same certificate
and key paths with the same localhost SANs, retain key mode `0600`, then start it.
Keep the database passwords and session secret unchanged.

The default project is `synixir-staging`. It publishes only `127.0.0.1:8443` and
uses the `synixir-staging_database` volume. It does not use the development database
or ports 4000, 5173 or 5432. To select another port or image at initialization:

```sh
elixir scripts/staging.exs init --port 8445 --image synixir:staging-v1
```

Use `--directory /absolute/private/path` before the subcommand to select a saved
installation. Use the wrapper for all Compose operations so its explicit project,
paths and generated environment remain together. Do not print `docker compose
config`, share `.env`, or put database URLs in command arguments.

## Release contents and ingress

The Dockerfile pins Node 24.12.0, Elixir 1.18.3, OTP 27.3.3, and matching Debian
Bookworm builder and runner images by digest. Lockfiles select dependencies.
Argon2 compiles its C NIF inside the target image; Yex selects a checksum-verified
GNU/Linux NIF for that architecture. The final image contains ERTS, the release,
native runtime libraries and built browser assets. It runs as `nobody` with a
read-only root filesystem and a writable temporary directory. Node, Mix, compiler
tools and source credentials are absent from the runner.

The CI job builds on native AMD64. The checked-in [ARM64 pilot result](deployment/pilot-result.json)
and [emulated AMD64 result](deployment/pilot-amd64-emulated.json) record the local
runs. Each pilot exercises both NIFs from the final image.
Building for another architecture requires testing that image on the target CPU.
For Docker CPU emulation, OTP's default JIT memory mapping can fail during Mix
compilation. The optional argument below enables OTP's emulation-compatible
mapping only in the builder; it does not alter the final runtime:

```sh
docker build --platform linux/amd64 --build-arg ERL_FLAGS='+JMsingle true' \
  --build-arg REVISION=local-emulated-check -t synixir:amd64-check .
```

The reproduction, runtime checks and primary sources are in
[deployment research](research/deployment-release.md).

The gateway terminates TLS and proxies WebSocket upgrades. It overwrites the
forwarded scheme and client address, rejects hosts other than `localhost`, bounds
HTTP bodies to 16 KiB, allows at most 64 active connections per IP, and applies
30 HTTP requests per second with a burst of 120. GET and HEAD requests for
`/_next/static/` assets are excluded from the request rate limit so loading editor
bundles leaves the API budget available; the connection limit still applies.
Existing channel limits govern messages after a WebSocket upgrade. These are
staging defaults, not capacity measurements. Gateway access logs are disabled to
avoid recording grant URLs.

The app requires `DATABASE_URL`, `SECRET_KEY_BASE` and an HTTPS origin in
`SYNIXIR_PUBLIC_URL`. WebSocket origin checks include the scheme and port. Session
cookies are Secure, HttpOnly and SameSite=Lax. The application listener must remain
private to the gateway because production trusts its forwarded headers. Internal
health checks and authenticated metrics scrapes use HTTP on that private network.
The gateway returns 404 for `/metrics`; Prometheus is not published to the host.

PostgreSQL runs separately. The app connects as the non-superuser `synixir`, which
owns its database. A one-off release command migrates before the app starts:
`bin/synixir eval 'Synixir.Release.migrate()'`. Migration and restore checks start
the repository without an HTTP listener. The Compose admin password is used for
database maintenance, not by Phoenix.

## Pilot and recovery checks

Install the browser pilot dependencies once:

```sh
npm ci
npx playwright install --only-shell chromium
elixir scripts/staging.exs pilot
```

The pilot creates owner, editor and viewer accounts. It checks shared editing,
read-only access, offline reconnect, the packaged example pages, cookie flags,
origin rejection and forged proxy headers. It stops only this installation's
database to check liveness 200, readiness 503 and recovery. Then it verifies a
backup, replaces the app with the same image and checks saved sessions, passwords,
roles and document state. It restores another backup to a temporary database and
checks that the private Prometheus scrape is up. Expect a short staging outage.

The private `pilot.json` retains fixture credentials and browser sessions.
`pilot-result.json` contains a report without credentials. Recheck an existing
pilot after an upgrade:

```sh
elixir scripts/staging.exs check-pilot
elixir scripts/staging.exs native-check
```

The pilot's document and memberships are fixtures. Editing them changes the
expected results. To run the entire rehearsal again without touching this
installation, CI and local development use a fresh, randomly named project:

```sh
elixir scripts/staging.exs rehearse --image synixir:staging \
  --output /tmp/synixir-release-pilot.json
```

This uses port 8444 by default. It removes only the project, volume and temporary
credentials it created, including on a failed check. Choose a new output filename
for each run. It never deletes the persistent staging volume.

## Backups and replacement

```sh
elixir scripts/staging.exs backup
elixir scripts/staging.exs verify /absolute/path/to/backup.dump
```

Backups are full PostgreSQL custom archives with a SHA-256 sidecar. Verification
creates a new database, restores tables as the application role, checks migration
versions, index validity and stored update digests, and replays every room through
Yex. It drops only the database created by that verification. Accounts, memberships,
password hashes, revisions, snapshots and raw updates must remain together.
See [operations](operations.md#back-up-and-verify) for recovery limits.

Build a distinct image tag for a candidate, then replace staging:

```sh
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t synixir:staging-v2 .
elixir scripts/staging.exs upgrade --image synixir:staging-v2
elixir scripts/staging.exs check-pilot
```

For an uncommitted build, append `-dirty` to its revision label, as the `build`
command does. `upgrade` records the old and new image IDs alongside a verified
backup, stops the gateway and old app, migrates with the candidate, then starts
one replacement. It waits for HTTPS readiness before saving the image reference.
The 40-second stop grace period accommodates Phoenix's socket draining. Keep the
previous image until the candidate has passed its pilot checks.

There is downtime. Running two application nodes at once would create competing
in-memory owners for rooms. Do not scale `app`, use rolling replacement, or treat
DNSCluster as a room ownership mechanism.

If a replacement fails, the helper leaves the gateway and app stopped. Inspect
the migration and application errors and the backup's `.upgrade.json` record.
Decide whether the old release supports the current schema before restarting it.
For a schema-compatible rollback, keep the current database, select the saved
previous image ID in the private `.env` as `SYNIXIR_IMAGE`, and run `up`, followed
by `check-pilot`. The migration command never runs down migrations. A schema that
the old code cannot read requires a forward fix or an explicit recovery plan.

Never restore an old archive over the current database automatically after a failed
upgrade. A backup predates later edits, grants and revocations. Rehearse recovery
in a fresh database, account for those changes, and choose the recovery point before
switching traffic. This pilot tests same-image replacement and restoration, not
arbitrary future migration compatibility.

## Stop and scope

```sh
elixir scripts/staging.exs stop
elixir scripts/staging.exs up
```

Stopping retains the database volume, credentials and backups. Do not remove the
volume to troubleshoot an application failure. Prometheus uses temporary storage,
so collector replacement resets its history and pending alerts.

This local target has no public domain, public certificate, image registry,
off-machine backup schedule, retention policy, Alertmanager destination or host
availability guarantee. Those require a separate deployment decision. Keep the
loopback binding and private database when using this configuration.
