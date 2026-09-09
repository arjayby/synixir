# Production readiness research

Researched on 2026-09-09 against SDK baseline `6796fec`, Phoenix 1.8.13, Elixir 1.18.3, DBConnection 2.10.2, Postgrex 0.22.4, and the repository's PostgreSQL 17.11 image. These are recommendations for a single-node operational milestone. They do not establish deployment capacity or availability guarantees.

## Health probes need an outer deadline

Keep liveness independent of PostgreSQL. It should confirm that the application can answer a small HTTP request. Readiness should also require the collaboration supervision subtree and a usable database schema. A dependency outage should make the instance unready without demanding an application restart. This distinction follows the [official probe guidance](https://kubernetes.io/docs/concepts/workloads/pods/probes/#when-should-you-use-a-readiness-probe); it does not require adopting Kubernetes.

A read-only query through the existing Repo is sufficient for a modest readiness check. Use `queue: false`, `timeout: 1000`, `log: false`, and a single query checking required tables and the expected migration version. Optionally reject `transaction_read_only = on`. Catch exceptions and exits and return a minimal `503` response. `SELECT 1` alone proves reachability, not schema compatibility or write permission. A schema check still cannot prove that the next write will commit or that a disk has free space.

The query options do not impose a strict HTTP response deadline. In pinned DBConnection, `Holder.checkout_call/5` waits for a pool reply without a `receive ... after`; the deadline timer starts after connection handoff. `queue: false` avoids the healthy pool's waiting queue but cannot interrupt a suspended pool. Source: [DBConnection 2.10.2 holder implementation](https://github.com/elixir-ecto/db_connection/blob/v2.10.2/lib/db_connection/holder.ex#L311). Ecto forwards the query options to Postgrex in [the SQL adapter](../../deps/ecto_sql/lib/ecto/adapters/sql.ex), which forwards them to DBConnection.

Use a short-lived, unlinked supervised task for the database probe, then `Task.yield/2` and `Task.shutdown(task, :brutal_kill)` on expiry. Bound concurrent probe tasks and treat task admission failure as unready. This provides an outer request deadline and cleans up blocked work without a periodic cache. Leave a small margin between the database and outer deadlines. Source: [Elixir 1.18.3 task lifecycle](https://github.com/elixir-lang/elixir/blob/v1.18.3/lib/elixir/lib/task.ex), [supervised unlinked tasks](https://github.com/elixir-lang/elixir/blob/v1.18.3/lib/elixir/lib/task/supervisor.ex).

An isolated probe against the compiled dependency called `Holder.checkout` on an alive process that never answered, with `timeout: 10, queue: false`. It was still blocked after 101 ms; task shutdown removed it. This probe started neither Synixir nor PostgreSQL. Timer deadlines remain subject to BEAM scheduling, so this is not a hard real-time guarantee.

## Export a small metric contract

Use `telemetry_metrics_prometheus_core` and expose `Core.scrape/1` through the existing Bandit endpoint. Protect `/metrics` with a dedicated bearer secret, fail closed when unconfigured, and keep the secret out of application/browser configuration and logs. This avoids the wrapper package's extra Cowboy listener. Core 1.2.1 supports counters, sums, last values, and distributions, but explicitly does not support `Telemetry.Metrics.summary`. Existing summary definitions therefore need a separate exporter-compatible list. Sources: [Core reporter](https://telemetry-metrics-prometheus-core.hexdocs.pm/TelemetryMetricsPrometheus.Core.html), [wrapper server](https://telemetry-metrics-prometheus.hexdocs.pm/TelemetryMetricsPrometheus.html).

Use seconds and bytes, counters ending in `_total`, and explicit `event_name` and `measurement` when renaming metrics. Histograms need configured buckets in the converted unit. Start with save, restore, join, and database duration distributions; counters for saves and bounded rejection reasons; gauges for active documents and admitted channels. Export `result`, normalized `event`, and quota `reason` only from finite allowlists. Room IDs, accounts, tokens, arbitrary channel events, and exception messages must not become labels. Each label combination creates another time series, and histogram buckets multiply that cost. Source: [Prometheus naming and cardinality](https://prometheus.io/docs/practices/naming/).

The existing Phoenix channel `event` tag is client-controlled. Prefer the sanitized Synixir event tags, or normalize it before reporting. The baseline reporter definitions are in [telemetry.ex](../../lib/synixir_web/telemetry.ex). Keep server processing duration separate from browser-to-durable-save latency. Duplicate idempotent saves can count as requests while inserting zero rows; request count is not a count of unique edits.

Return `text/plain; version=0.0.4; charset=utf-8` and the reporter's body unchanged. The format requires a final newline, correctly escaped labels, and consistent histogram buckets. Source: [Prometheus text exposition](https://prometheus.io/docs/instrumenting/exposition_formats/). Check actual output with `promtool check metrics`; check rule files with `promtool check rules` before wiring them into a collector. Source: [promtool commands](https://prometheus.io/docs/prometheus/latest/command-line/promtool/).

Example rules below assume these metric names are adopted. Match them to an actual scrape before use. A readiness gauge is useful only if it has a defined refresh interval; a stale successful sample must not be presented as current readiness.

```yaml
groups:
  - name: synixir
    rules:
      - alert: SynixirScrapeUnavailable
        expr: up{job="synixir"} == 0
        for: 1m
        annotations:
          summary: Synixir metrics cannot be scraped
      - alert: SynixirStorageFailures
        expr: sum(increase(synixir_document_save_total{result="storage_unavailable"}[5m])) > 0
        annotations:
          summary: A document save failed because storage was unavailable
```

The `for` clause delays firing until the condition persists. Alertmanager delivery is separate from evaluating rules. Source: [Prometheus alert rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/). Add readiness and latency alerts once their signals and thresholds are measured. A local smoke run cannot justify a production latency SLO. Expected authorization and quota denials should not count as storage outages.

## Admission limits must survive process failure

Track admitted joined channels by account, room, and node. Monitor each reservation owner, release on `DOWN`, and release failed joins explicitly. The baseline [socket](../../lib/synixir_web/channels/document_socket.ex) has no account identity until a grant-authenticated join, so describe this as joined-channel admission. It does not bound anonymous raw WebSockets.

If an in-memory admission process restarts while its channels remain alive, it forgets reservations and can over-admit. A `rest_for_one` collaboration subtree with admission before document workers and Endpoint can restart dependent owners together. An alternative is rebuilding reservations before accepting new work. Serialize durable room-creation quotas with the same per-account database lock used for creation. The active-document limit should count idle resident workers too. Sources: [Elixir supervision strategies](https://hexdocs.pm/elixir/1.18.3/Supervisor.html), [existing document supervision](../../lib/synixir/documents/supervisor.ex).

State exactly what a byte quota measures. Snapshot bytes plus raw log bytes bound retained encoded storage, not decoded Yjs heap, process memory, transient compaction allocation, or browser state. Binary compaction preserves history and does not promise garbage collection. Source: [Yjs alternative update API](https://docs.yjs.dev/api/document-updates#alternative-update-api).

## Backups need a semantic restore drill

Use PostgreSQL 17 tools and a full `pg_dump --format=custom` archive. It produces a consistent database snapshot while writers remain active, and avoids accidentally omitting sequences or dependent schema through table filters. Database-global roles and tablespaces require separate handling. Inspect exit status and stderr, and record archive checksum, tool versions, start/end time, and schema version. Source: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

Create a fresh, uniquely named target database from `template0`. Restore with `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges --dbname=<target> <archive>`. Never use `--create` or `--clean` in this drill. `--create` can reconnect to the database name stored in the archive. Single-transaction restore is atomic and cannot use parallel jobs. `--list` inspects the archive table of contents; it does not verify restored application behavior. Source: [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).

The drill should create both source and target fixture databases with a restricted prefix and random suffix. Refuse existing targets. Cleanup must drop only database names successfully created by this run. Explicitly configure every Repo used by the drill; baseline [test configuration](../../config/test.exs) selects `synixir_test` and does not gain isolation merely by setting `DATABASE_URL`. Never point fixture migrations, load tests, or restore verification at `synixir_dev`, `synixir_test`, or the original checkout's servers.

Verify the fixture after restoration through application code:

- Account password hashes, sessions, room ownership, memberships, and revocation versions survive.
- Schema migrations, constraints, indexes, and sequences permit another valid insert.
- A compacted document with a raw tail restores its text, including deletions.
- A pending insertion and pending deletion survive without their missing base update. Supply that base only in the isolated restored database and verify the expected final text.

The last check matters because pinned Yex's document encoding can lose pending dependencies. The application stores merged raw update bytes to preserve them. A text-only export or visible-text comparison is insufficient. Sources: [storage compatibility evidence](storage-lifecycle.md), [current storage implementation](../../lib/synixir/documents/store.ex).

A full database snapshot observes the committed snapshot/log replacement together. Do not compare its row counts with a live source that has continued changing. Measure restored fixture contents against fixed expectations. Backup age bounds possible lost writes; restore elapsed time measures only this dataset and machine. Restoring an older database also restores older access decisions, so a real disaster cutover needs a session invalidation and access reconciliation decision.

Archives contain private documents and authentication data. Use restrictive output permissions and an explicit `PGPASSFILE` instead of embedding passwords in printed commands. PostgreSQL requires Unix password-file permissions such as `0600`. Source: [PostgreSQL password files](https://www.postgresql.org/docs/17/libpq-pgpass.html). Off-machine storage, retention, encryption, scheduling, and recovery ownership remain deployment work.

## Measure the SDK's behavior

A browser load scenario can use the existing SDK and Playwright without editor rendering. Exercise multiple rooms, shared-room fanout, reconnect with offline edits, awareness, a chunked update, and a fresh observer after persistence. Count successful operations only after `saveStatus` reaches `saved` and observers converge. `connect()` resolves synchronization, not durability. Source: [SDK contract](../../packages/client/README.md).

Node 24 also has a built-in browser-compatible WebSocket, so a protocol load runner can import the SDK with an explicit `serverUrl` and custom `getAccess`. Its fetch calls do not acquire the browser example's login session automatically. This needs deliberate fixture authentication and is not evidence of browser UI performance. Sources: [Node WebSocket](https://nodejs.org/api/globals.html#class-websocket), [SDK implementation](../../packages/client/src/index.js).

Record offered rate, achieved rate, concurrent clients/rooms, update sizes, rejected requests, save and convergence percentiles, reconnect duration, server memory/run queue, database queue time, and generator CPU. If every client waits for an acknowledgement before its next edit, label the run closed-loop. It reduces offered load when the server slows and cannot establish an overload ceiling. Shared localhost resources, short runs, and small fixtures limit every capacity claim. Preserve raw results and distinguish a functional smoke result from measured production sizing.
