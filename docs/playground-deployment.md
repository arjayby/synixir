# Deploy the playground to Render

The root Dockerfile packages all seven playground pages into the Phoenix release.
Render serves HTTPS and WebSockets on the same origin. Accounts, permissions, and
document updates persist in PostgreSQL.

## Create the database

For a free demo, create a [Neon Free project](https://neon.com/pricing). Choose a
region near your Render service; `render.yaml` defaults to Ohio.

Copy the **direct**, non-pooled PostgreSQL connection URL from Neon's Connect
dialog. Keep the username, password, hostname, and database, but replace its query
string with `?ssl=true` for Ecto/Postgrex, for example:

```text
postgresql://USER:PASSWORD@HOST/DATABASE?ssl=true
```

Postgrex uses certificate and hostname verification with `ssl=true`. The image
includes system CA certificates. Do not use `sslmode=require` alone: Postgrex
does not use libpq's connection options to enable TLS. Direct connections also
avoid transaction-pooler restrictions on migration locks and prepared statements.

Render's own free PostgreSQL database expires after 30 days. Neon has storage,
compute, and transfer limits; check its current free allowances before deploying.
See [Render's free limits](https://render.com/docs/free).

## Create the Render service

Push the deployment files to the Git branch you want Render to build. In the
[Render dashboard](https://dashboard.render.com), select **New → Blueprint**,
connect this repository, and select that branch. Render reads `render.yaml` and
creates one **Free** Docker web service.

The Blueprint prompts for two environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The direct PostgreSQL URL with `?ssl=true` |
| `SECRET_KEY_BASE` | A new secret from `mix phx.gen.secret` (at least 64 characters) |

Keep these values in Render's environment settings. Retain the session secret
across replacements so existing sessions remain valid.

The startup command uses Render's `RENDER_EXTERNAL_HOSTNAME` to set the public
HTTPS origin. For a custom domain, set `SYNIXIR_PUBLIC_URL` explicitly to that
HTTPS origin before starting the service. This controls session redirects and
the WebSocket origin allowlist.

On each start, the release checks Yex and Argon2, applies pending database
migrations, then starts Phoenix. Free web services do not support Render's
separate pre-deploy command, so these checks run in the startup command instead.
The readiness probe is `/health/ready`. See
[Render's Docker guide](https://render.com/docs/docker) and
[Blueprint reference](https://render.com/docs/blueprint-spec).

## Verify the playground

Wait for the service to become healthy, then open its assigned `onrender.com` URL.
Create an account and a room. Open that room in two tabs, edit the text, and
confirm both tabs converge and show **Saved**. Check the other six examples from
the header menu. To collaborate across accounts, grant the second username
access through **Manage access**.

Free services sleep after 15 minutes without HTTP or WebSocket traffic. Waking
takes about a minute, and the database may also need to wake. Saved state stays
in PostgreSQL; unsaved offline changes survive only while the browser tab stays
open. The 512 MB instance is intended for a small demo, not a measured capacity
guarantee.

## Replace the service

Keep **one running application instance**. Synixir currently owns rooms in memory
on one node. Render's normal redeploy and restart flows temporarily run old and
new instances together, even with `numInstances: 1`. Automatic deploys are disabled
in the Blueprint to avoid starting this flow on a Git push.

For an upgrade, back up the database, suspend the old service, and wait until it
has stopped. Create a replacement service from the new commit with a different
service name and the same database and session secret. Keep the old service
suspended while the replacement runs. The replacement receives a new Render URL;
update any custom domain after verification. Avoid the normal **Restart service**
and manual redeploy flows while the old instance is running. This replacement
procedure has downtime.

The [operations guide](operations.md#back-up-and-verify) covers database backup
and recovery. An image rollback does not undo migrations.
