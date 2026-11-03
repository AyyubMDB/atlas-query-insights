# Atlas Query Profiler Collector (Node.js)

Pulls MongoDB Atlas **Query Profiler** data (the "Query Insights →
Query Profiler" tab) via the **Atlas Administration API** — without ever
logging into the customer's Atlas account or needing a database user.
This works even when the customer's Atlas organization enforces SSO for
human logins, because **API keys are a separate credential type from
user logins and are not subject to SSO.**

For each slow operation it captures execution time, docs/keys examined
vs returned, whether an index/sort was used, the plan summary (COLLSCAN
detection) — **and the exact query/command that ran** (filter,
pipeline, sort, update spec, etc.), so you can go straight from "this is
slow" to "here's the query and here's what index would fix it."

A secondary script also pulls the rest of Performance Advisor (suggested
indexes, schema advice, drop-index suggestions) if/when you want it.

There's also an optional local **web UI** (`server/`) with filters,
sortable columns, a time-vs-execution-time scatter chart, and a
click-to-inspect detail panel for a single operation — see
[Web UI](#web-ui-filter-sort-drill-into-a-query) below. `report.md`
keeps working exactly as before regardless of whether you use the UI.

## How access works (no SSO / no cluster login needed)

1. Your customer (an `Organization Owner` or `Project Owner`) creates a
   **Project API Key** scoped to just the one project/cluster you need,
   with role **`Project Read Only`** PLUS **`Project Data Access Read
   Only`** (or `Project Observability Viewer`) — the second role is
   required to see real field *values* in queries; without it Atlas
   redacts them and you'll only see query structure.
2. They give you the resulting **Public Key** (username) and **Private
   Key** (password) — a one-time copy/paste, no account invite required.
3. They add your outbound IP address (or a small CIDR range) to the API
   key's **IP Access List** (required unless their org disabled that
   requirement).
4. You authenticate to `https://cloud.mongodb.com/api/atlas/v2` using
   **HTTP Digest Auth** with that public/private key pair. This grants
   read-only access to cluster metadata, Performance Advisor, and
   monitoring data — but explicitly **not** general read/write access to
   the data stored in the database itself (no ad-hoc `find()`/
   `aggregate()` on their collections; you only see whatever queries
   happen to show up in the slow query log).

This is the standard, MongoDB-documented way to grant third parties
programmatic-only access:
https://www.mongodb.com/docs/atlas/configure-api-access/

### Steps for your customer to run (share this with them)

1. Atlas UI → select the **Project** → **Project Settings** → **Access
   Manager** (left sidebar) → **Applications** tab → **API Keys** →
   **Create API Key**.
2. Description: e.g. `<your-company> read-only query profiler access`.
3. Project Permissions: `Project Read Only` **and** `Project Data Access
   Read Only` (needed to see real filter values, not just shapes).
4. Click **Next**, copy the **Public Key** and **Private Key** (private
   key is shown once).
5. Add an **API Access List** entry for your IP (or `0.0.0.0/0` if their
   org allows it and your IP isn't fixed — less secure, avoid if
   possible).
6. Send you the Public Key, Private Key, Project ID (`groupId`, visible
   in Project Settings), and the cluster name(s).

No SSO login, no cluster database user, no VPN/peering is required. The
Admin API is only reachable over the public internet (not via VPC
peering/private endpoints), so this also works if you're outside their
network.

## What the Query Profiler collector gives you

Backed by: `GET /groups/{groupId}/processes/{processId}/performanceAdvisor/slowQueryLogs`
— this is the exact same data source as the Atlas UI's Query Profiler
tab (confirmed in MongoDB's docs: Performance Advisor and Query Profiler
both read from this endpoint).

Per slow operation:

| Field | Meaning |
|---|---|
| `namespace`, `opType` | `db.collection` and operation type (query/command/update/...) |
| `operationExecutionTimeMs` | Total time the op took |
| `docsExamined` / `docsReturned` / `docsExaminedReturnedRatio` | Scan efficiency — high ratio = scanning way more than needed |
| `keysExamined` / `keysExaminedReturnedRatio` | Index-entry scan efficiency |
| `hasSort` | `true` = in-memory sort (no index could satisfy the sort) |
| `hasIndexCoverage` | `false` = no index used (often paired with `planSummary: COLLSCAN`) |
| `planSummary` | e.g. `COLLSCAN` or `IXSCAN { field: 1 }` — which index (if any) was picked |
| `numYields`, `responseLengthBytes`, `tokensUsed` (for `$rerank`) | Additional profiling detail |
| **`exactQuery`** | **The exact filter/pipeline/update/sort document that executed**, extracted from the raw mongod log line (`attr.command`) |
| `exactQueryObj` | Same, as a structured object (JSON output only, omitted from CSV) |
| `appName` | Client application name that issued the query, if the driver sets it |

`processId` values (`host:port`) are derived automatically from the
cluster's connection string — you don't need to hunt for them manually.

> **Note:** There isn't a separate public API strictly named "Query
> Insights" — the Atlas UI's Query Insights page (Performance Advisor +
> Query Profiler tabs) is powered by this same `slowQueryLogs` endpoint.
> If you ever need the full, uncapped raw `mongod` logs (the UI/API cap
> around ~100k sampled log lines), use the log download endpoint instead:
> `GET /groups/{groupId}/clusters/{hostName}/logs/{logName}.gz`.

## Setup

Requires Node.js 18+.

```sh
npm install
cp .env.example .env
# fill in ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID, ATLAS_CLUSTER_NAMES
```

Sanity-check that your key can see the cluster and resolve its hosts:

```sh
node src/index.js --list-processes
```

Run the Query Profiler collector:

```sh
npm run profile
```

Or with ad-hoc filters instead of editing `.env`:

```sh
node src/profiler.js --cluster Cluster0 \
  --since 1724500000000 --duration 86400000 \
  --namespaces mydb.orders,mydb.users \
  --op-types find,aggregate \
  --top 30
```

| Flag | Env fallback | Meaning |
|---|---|---|
| `--cluster` | `ATLAS_CLUSTER_NAMES` | Cluster to profile |
| `--since` | `ATLAS_SINCE_MS` | Epoch ms start of window |
| `--duration` | `ATLAS_DURATION_MS` | Window size in ms |
| `--namespaces` | `ATLAS_NAMESPACES` | Comma-separated `db.collection` filter |
| `--op-types` | `ATLAS_OP_TYPES` | Comma-separated op type filter (client-side) |
| `--top` | `ATLAS_TOP_N` | How many worst offenders to list in the report |

This writes, per cluster, into `output/<clusterName>/profiler-<timestamp>/`:

- `slow-queries-raw.json` — full raw API response per host
- `slow-queries-flattened.json` — flattened rows incl. `exactQueryObj`
- `slow-queries.csv` — same, spreadsheet-friendly (`exactQuery` as a JSON string column)
- `namespaces.json` — which collections are seeing slow ops, per host
- `analysis.json` — rollups: totals, per-namespace, per-opType, top-N slowest, top-N worst scan efficiency
- **`report.md`** — human-readable summary with the exact query for each top offender in a fenced code block — start here

A console summary (COLLSCAN %, avg/p50/p95/p99 execution time, top
namespaces) is also printed after each run.

### Example `report.md` excerpt

```
## Top Slowest Queries
**1. mydb.orders** — query — 1450 ms — plan: `COLLSCAN` — docsExamined/Returned: 500000/50 — app: billing-service

​```json
{
  "find": "orders",
  "filter": { "status": "pending", "region": "us-east" },
  "sort": { "createdAt": -1 },
  "limit": 50
}
​```
```

## Web UI (filter, sort, drill into a query)

`report.md` stays as-is for a static/shareable summary. For interactive
work — filter by namespace/opType/app, sort any column, click a point on
a time-vs-execution-time scatter chart, and open a detail panel for a
single operation (exact query + full metrics + raw log line) — there's a
small local web app in `server/`.

It's read-only and separate from the collector: `npm run profile` writes
samples into **your own MongoDB cluster** (`ATLAS_STORAGE_URI` — not the
customer's), and the UI just queries that collection.

```sh
# 1. Point ATLAS_STORAGE_URI at a cluster you control (see .env.example)
# 2. Either collect real data...
npm run profile
# ...or try it immediately with synthetic demo data:
npm run seed:demo

# 3. Start the UI
npm run ui
# -> http://localhost:4000
```

What it gives you (deliberately mirroring Atlas's own Query Profiler UX):

- **Filter bar**: namespace, op type, app name, host, min/max execution
  time, COLLSCAN-only, no-index-coverage-only, free-text search (matches
  namespace/app/exact query text)
- **Summary cards**: total samples, COLLSCAN rate, in-memory sort count,
  no-index-coverage count, avg/p95/p99 execution time — computed with the
  same `analyze.js` logic that generates `report.md`, so numbers always
  match
- **Scatter chart**: execution time vs. time logged, red = COLLSCAN;
  click a point to open its detail panel
- **Sortable table**: click any column header to sort (execution time,
  docs examined/returned, ratio, namespace, etc.), with pagination
- **Detail panel**: click any row (or chart point) to see every metric,
  the **exact query executed** (pretty-printed JSON), and the raw mongod
  log line

Data flow: `Atlas Admin API → profiler.js → your MongoDB cluster → Express API (server/index.js) → static frontend (server/public/)`.
Samples are upserted by a stable hash of `(processId, raw log line)`, so
re-running the collector over overlapping time windows never creates
duplicates.

Utility scripts:

```sh
npm run seed:demo                 # populate "DemoCluster" with synthetic data to try the UI
node scripts/clear-cluster.js <sourceCluster>   # wipe stored samples for a given cluster
```

## Continuous collection (recommended)

The Atlas UI/API only retain a rolling window (Query Profiler ~24h by
default, Performance Advisor up to 5 days). To build a proper
performance-improvement history, run this on a schedule and keep the
JSON/CSV artifacts:

```sh
npm run profile:watch
```

Uses `COLLECT_CRON` from `.env` (default: every 4 hours).

For production use, prefer a scheduled job (cron, GitHub Actions
scheduled workflow, or a small container) rather than keeping a laptop
process alive, and forward `output/` to S3/GCS or a database for
longer-term trend analysis.

## Optional: full Performance Advisor bundle

If you later also want suggested indexes, schema anti-pattern advice,
and drop-index suggestions (not just the profiler), run:

```sh
npm run collect:full
```

This writes `suggested-indexes.json`, `schema-advice.json`, and
`drop-index-suggestions.json` alongside the same slow-query output,
using `GET /groups/{groupId}/clusters/{clusterName}/performanceAdvisor/*`.

## Security notes

- Keep `.env` out of version control (already in `.gitignore`).
- Request the *minimum* roles needed (`Project Read Only` +
  `Project Data Access Read Only`). Do not request write roles.
- Slow query data can contain sensitive field values (that's the point —
  you need them to debug queries). Treat exported JSON/CSV files, and the
  storage cluster/collection, with the same sensitivity as the customer's
  data.
- Ask the customer to set an expiration / rotate the key periodically,
  and to scope the IP access list to your egress IP(s).
- The Admin API key cannot run ad-hoc reads/writes against their
  database — only metadata, metrics, and whatever already landed in the
  slow query log. This is by design and is the safest way to get this
  data without full cluster access.
- **`ATLAS_STORAGE_URI` credentials are as sensitive as any other database
  password.** Anything pasted into a chat/terminal history, ticket, or
  Slack message should be treated as compromised — rotate that database
  user's password in Atlas (Database Access → Edit User → Edit Password)
  after testing, and going forward pass secrets only through `.env` files
  or a secrets manager, never in plain chat.
- Use a dedicated database user scoped to only `ATLAS_STORAGE_DB` (not an
  admin/all-database user) for the storage cluster, since `server/`
  exposes this data over a local HTTP API.
- `server/index.js` has no authentication layer by design — it's meant
  for single-user, local-laptop use only. It binds to `127.0.0.1` by
  default (not `0.0.0.0`), so it isn't reachable from the network even on
  the same Wi-Fi. If you ever need to run it somewhere shared/remote,
  add an auth layer first and reconsider the `UI_HOST` override.

## Files

```
src/
  atlasClient.js              Digest-auth HTTP client for the Atlas Admin API
  collectors/
    clusters.js                Fetch cluster doc, derive host:port process IDs
    slowQueries.js              Slow query log fetch, metrics + exact-query extraction, CSV flattening
    performanceAdvisor.js       Suggested indexes / schema advice / drop suggestions / namespaces
  utils/csv.js                 Dependency-free CSV serializer
  analyze.js                   Rollups (per-namespace/opType, top-N) + Markdown report renderer
  storage.js                   MongoDB storage layer (upsert-by-hash, indexes) for the UI
  profiler.js                  PRIMARY entrypoint: Query Profiler collector + report + storage write
  index.js                     Secondary entrypoint: full Performance Advisor bundle
  scheduler.js                 Optional cron-based repeated collection (profiler.js)
server/
  index.js                     Express API (filters/sort/pagination/detail) — read-only against storage
  public/
    index.html                  UI shell
    app.js                       Filter/sort/pagination/chart/detail-panel logic
    styles.css                   Dark theme styling
scripts/
  seed-demo.js                 Populate "DemoCluster" with synthetic samples to try the UI immediately
  clear-cluster.js             Delete all stored samples for a given sourceCluster
```
