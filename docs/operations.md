# Operations

Step 10 adds limits, probes, metrics, alert rules, load checks and verified database
backups. Synixir still runs on one Phoenix node. Step 11 adds
[local Docker staging](deployment.md), HTTPS, a private collector and a release
pilot. External alert delivery and off-machine backup scheduling remain unconfigured.

## Quotas

Set these environment variables before starting Phoenix. Values must be positive
integers; invalid values fail startup. Restart the application after changing them.
The defaults are guardrails, not a measured capacity recommendation.

| Variable | Default | Scope and rejection |
|---|---:|---|
| `SYNIXIR_CHANNELS_PER_NODE` | 1000 | Joined room channels on this node; `node_channel_quota` |
| `SYNIXIR_CHANNELS_PER_ROOM` | 100 | Joined channels in one room; `room_channel_quota` |
| `SYNIXIR_CHANNELS_PER_ACCOUNT` | 20 | Joined channels across an account's tabs and rooms; `account_channel_quota` |
| `SYNIXIR_ACTIVE_DOCUMENTS` | 200 | Resident document workers, including the idle grace period; `document_quota` |
| `SYNIXIR_ROOMS_PER_ACCOUNT` | 100 | Active owner memberships; creation, adoption and promotion return `room_quota` |
| `SYNIXIR_STORED_BYTES_PER_ROOM` | 268435456 | Snapshot bytes plus retained raw update bytes; `storage_quota` |

Channel admission follows authentication and precedes opening a document.
Failed joins release their reservation; process monitors release disconnected
channels. Losing admission state restarts its document and endpoint subtree so
the node cannot forget reservations while continuing to serve those connections.
Resident workers free a slot on exit. Idle rooms normally unload after 60 seconds.

Owner quotas serialize creation and owner promotion using a database lock per
account. They survive application restarts. Editor and viewer memberships do not
consume owner quota. Room quota errors use HTTP 429. Channel quota errors appear
in the join reply and stop that SDK connection attempt until `connect()` is called.

Stored bytes are checked under the same room transaction lock as append and
compaction. A refusal happens before the live document changes. A repeated raw
update already in the log consumes no additional space and can be acknowledged
at the limit. After compaction removes that row, resending it can consume log space
again. Existing documents over a lowered limit remain readable.

When a room fills, the client keeps its draft and reports `storage_quota`. Ask the
user to keep the tab open or copy the draft. Inspect retained bytes, compact if
appropriate, or raise the configured limit, then reconnect to retry. Deleting text
also adds CRDT history and may not free space. Never delete update rows to make room.

These quotas do not bound anonymous WebSockets, registration, aggregate traffic
per IP, total database size, decoded Yjs heap, or temporary transfer/compaction
memory. The existing 1 MiB message, 64 MiB transfer and per-channel rate limits
still apply. Set deployment gateway and host limits before accepting public traffic.

## Health and metrics

| Endpoint | Response |
|---|---|
| `GET /health/live` | 200 with `{"status":"ok"}` if Phoenix can answer; no database query |
| `GET /health/ready` | 200 when a schema query succeeds, admission responds and document supervision exists; otherwise 503 with `{"status":"unavailable"}` |
| `GET /metrics` | Prometheus text with a valid bearer token; 404 when disabled, 401 for missing or incorrect authorization |

Readiness uses an unlinked task with a one-second outer deadline and a 750 ms
database timeout. At most four probes can run together; saturation returns 503.
The outer deadline also covers stalled checkout or admission. It is subject to VM
scheduling. The read-only query checks required tables and columns; it does not
prove that the next write will commit or that disk space and write privileges suffice.
Use readiness to remove an instance from service, and liveness for restart decisions.

Set `SYNIXIR_METRICS_TOKEN` to a random secret of at least 32 bytes. For example,
generate a secret with `mix phx.gen.secret` and supply it through your deployment's
secret management. Scrapers send `Authorization: Bearer <secret>`. All three
endpoints return `Cache-Control: no-store` and create no session cookie. Use TLS
or a private network for scrapes; keep the token out of frontend code and URLs.

Each authenticated scrape runs readiness and refreshes the gauges. A dependency
outage still returns metrics with `synixir_ready 0`. The example scrape timeout is
five seconds. Gauges also sample every ten seconds. No room IDs, usernames, tokens,
document text or arbitrary client strings become labels.

| Metric | Meaning |
|---|---|
| `synixir_document_{save,restore,compact}_total{result}` | Requests, including retries and failures |
| `synixir_document_{save,restore,compact}_duration_seconds` | Histograms, labeled by result |
| `synixir_document_{save,restore,compact}_bytes_total{result}` | Bytes reported by those operations; includes retry traffic |
| `synixir_channel_joins_total{result}` | Join outcomes |
| `synixir_channel_messages_total{event,result}` | Incoming messages, with finite label allowlists |
| `synixir_quota_rejections_total{reason}` | Quota refusals, including trusted server calls |
| `synixir_readiness_checks_total{result}`, `synixir_ready` | Probe outcomes and latest readiness |
| `synixir_channels_active`, `synixir_channel_limit` | Admitted channels and configured node ceiling |
| `synixir_documents_active`, `synixir_document_limit` | Resident workers and configured ceiling |
| `synixir_database_{query,queue}_seconds` | Query and connection checkout histograms |
| `synixir_vm_memory_bytes`, `synixir_vm_run_queue` | BEAM-reported memory and runnable queue length |

The exporter adds the usual histogram `_bucket`, `_sum` and `_count` series.
Unknown label values become `other`. A time series appears after its first event.
Save duration measures server persistence, including lock waits. SDK-to-save time
also includes transport and scheduling. BEAM memory is not operating-system RSS
and can omit native allocations; monitor container/host memory and disk separately.

## Alerts

[prometheus.yml](../ops/prometheus.yml) is a collector example. Set its target,
mount the token file and configure Alertmanager delivery in the deployment.
Local Docker staging starts a private collector with these rules. It does not
send notifications; configure Alertmanager delivery before relying on paging.

[alerts.yml](../ops/alerts.yml) detects an unavailable scrape, failed readiness,
storage errors, admission above 90 percent, repeated quota refusals, save p95 over
250 ms and average database checkout above 50 ms. Timing and quota thresholds are
starting values to tune against the deployed workload. Storage errors page
separately from expected authorization or quota refusals. The rule tests cover
that distinction and clearing a storage alert after its five-minute window.

If readiness fails, check PostgreSQL connectivity, schema compatibility and the
collaboration supervisor. If saves or restores fail, inspect application and
database errors and disk space before asking clients to retry. For queue or
capacity pressure, inspect active channels, resident workers, pool use and memory
before raising limits. Horizontal scaling requires a separate room ownership design.

Validate with the pinned [Prometheus 3.5.5](https://github.com/prometheus/prometheus/releases/tag/v3.5.5)
tool image used by CI. These commands run no collector and expose no port:

```sh
docker run --rm --network none --entrypoint promtool -v "$PWD/ops:/work:ro" -w /work prom/prometheus:v3.5.5 check config --syntax-only prometheus.yml
docker run --rm --network none --entrypoint promtool -v "$PWD/ops:/work:ro" -w /work prom/prometheus:v3.5.5 check rules alerts.yml
docker run --rm --network none --entrypoint promtool -v "$PWD/ops:/work:ro" -w /work prom/prometheus:v3.5.5 test rules alerts.test.yml
```

Syntax-only configuration validation does not check deployment token files or
reachability. CI also validates an actual application scrape using `check metrics`.

## Back up and verify

Use Elixir 1.18+ with Erlang/OTP 27+ and PostgreSQL 17 client tools. The examples
use the repository's PostgreSQL container, `synixir-db-1`. `--docker-container` runs tools
inside that specific container against its local database. Omit it to use native
tools with libpq's `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSFILE` or `PGPASSWORD`.

The CLI uses only standard libraries. Restore verification, drills, and load
checks also run the application through Mix and require its dependencies.
Run `elixir scripts/operations_test.exs` to test the standalone script support.

```sh
elixir scripts/operations/database.exs --docker-container synixir-db-1 backup --database synixir_dev --output /secure/backups/synixir.dump
elixir scripts/operations/database.exs --docker-container synixir-db-1 verify /secure/backups/synixir.dump
elixir scripts/operations/database.exs --docker-container synixir-db-1 drill --output /tmp/synixir-restore.json
```

Create the output directory first and choose a new filename on each run. Backups
contain document and authentication data. The tool creates archives and JSON
manifests with mode 0600, refuses existing outputs, checks command exit status,
and removes an incomplete archive when dumping fails. The manifest records
SHA-256, size, tool version, times and migrations observed before the dump.
Avoid running schema migrations during backup; ordinary writers may remain active.
A full custom-format `pg_dump` captures a consistent committed database snapshot.
It excludes cluster-global roles and tablespaces.

`verify` requires the archive and its adjacent `.json` manifest. Use trusted
archives: restore executes SQL from the archive. The tool verifies the checksum,
creates a new `synixir_restore_<random>` database from `template0`, and restores
with `--single-transaction --exit-on-error --no-owner --no-privileges`.
It never uses `--create`, `--clean`, or an existing target database.

The application check requires this checkout's exact migration versions, valid
indexes and checksums, decodable Yjs binaries, and replay of every room's snapshot
and raw tail. It cannot infer missing data that was absent before a backup or
compare against a source that has continued changing.

The separate `drill` creates its own source and restore databases. It tests password
hashes, sessions, ownership, editor/viewer permissions, revoked grants and sessions,
snapshot-plus-tail text, and pending insert/delete dependencies. It supplies the
missing base only after restoration and verifies the resulting text. New inserts,
sequence progress, foreign keys and role constraints are checked too. The drill
also tests quotas with independent concurrent transactions, resident document
admission, supervisor restart cleanup, and a stalled database checkout.

Fixture migrations and checks set `MIX_ENV=test` and an explicitly guarded
`SYNIXIR_OPERATIONS_DATABASE`. They use a regular pool of ten connections.
Application connections use `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD`, defaulting
to the local Compose settings. Unlike native PostgreSQL tools, the Elixir check
does not read `PGPASSFILE`. Ensure application and container/native tools reach the
same cluster. No server listener starts for restore checks. The tools drop only
database names successfully created by that invocation, even on ordinary failures.
They never drop `synixir_dev` or `synixir_test`. An uncatchable process/host crash
can leave a generated database for an operator to inspect and remove.

For disaster recovery, retain encrypted copies off the database host, define a
backup schedule and retention, and assign a recovery owner. Rehearse against a
representative dataset before setting recovery time and loss objectives. An older
backup restores older access decisions too; plan session invalidation and access
reconciliation before a real cutover. This milestone creates no schedule or
external storage policy.

## Load check

```sh
elixir scripts/operations/database.exs --docker-container synixir-db-1 load --clients 12 --rooms 3 --writes 100 --output /tmp/synixir-load.json
docker run --rm -i --network none --entrypoint promtool prom/prometheus:v3.5.5 check metrics < /tmp/synixir-load.json.prom
```

Run from the repository root after `mix deps.get` and `npm ci`, using Node 24.
The runner creates `synixir_load_<random>`, migrates it, and starts a loopback-only
Phoenix test server on port 4012. `--port` can select another unused port; the
development and browser fixture ports are refused. It stops only its server and
drops only its generated database. Run load measurements by themselves for useful
timings. ExUnit and browser tests must also run separately from each other.

Each client uses the SDK with its own account, cookie jar and CSRF token. Room
owners grant editor access through the public API. After warmup, each writer changes
its own Y.Map key, waits for `saved` and convergence across its room, then pauses
25 ms. The report includes measured update bytes, achieved writes/second, save and
convergence percentiles, connection/reconnect time, generator CPU, and server
memory/queue samples. A rejection or timeout fails the command; no success report
is written. Commands have a five-minute subprocess deadline. CLI bounds are 100
clients and 1000 writes per client; configured server quotas still apply, including
the extra fresh reader.

The scenario verifies awareness, offline edits, a 1.1 MB chunked update, a fresh
reader, and admission cleanup. After the server stops, a separate process checks
all persisted rooms. It writes a JSON report and a `.json.prom` scrape alongside
it. The default CI run uses 12 clients, 3 rooms and 20 writes each.

This is a closed-loop functional load check. Slow acknowledgements reduce the
offered rate. It uses a single localhost generator, test password costs, no TLS
and no editor rendering. It does not establish a production throughput ceiling,
open-loop overload behavior or a latency SLO. Longer runs on deployment hardware
with representative document sizes and host/RSS/disk monitoring are still needed.

## Recorded checks

The [load sample](operations/load-sample.json) and
[restore drill](operations/restore-drill.json) record local runs on 2026-09-09.
The load sample uses 12 SDK clients in 3 rooms for 1,200 writes and verifies all
three rooms from storage. The restore dataset is deliberately small; its measured
duration includes creating the target, restoring, application checks and cleanup.
Neither result is a production sizing or recovery guarantee.

CI runs ExUnit, SDK tests, the packed-package consumer, browser builds and browser
interoperability before the isolated restore and load checks. Promtool validates
the rules, alert behavior and scrape from that load run. Supporting decisions and
primary sources are in the [research notes](research/production-readiness.md).
