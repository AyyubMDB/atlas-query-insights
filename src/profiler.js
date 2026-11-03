/**
 * Query Profiler collector — this is the focused entrypoint that mirrors
 * the "Query Profiler" tab under Query Insights in the Atlas UI.
 *
 * It pulls raw slow-query log entries (Atlas Admin API:
 * performanceAdvisor/slowQueryLogs) for every host in a cluster, then
 * produces:
 *   - slow-queries-raw.json   full API responses
 *   - slow-queries.csv        flattened rows for spreadsheets
 *   - analysis.json           rollups (per-namespace, per-opType, top N)
 *   - report.md               human-readable Markdown summary
 *
 * Usage:
 *   node src/profiler.js
 *   node src/profiler.js --cluster Cluster0 --since 1724500000000 --duration 86400000
 *   node src/profiler.js --namespaces mydb.orders,mydb.users --op-types find,aggregate
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { AtlasClient } from "./atlasClient.js";
import { getCluster, extractProcessIds } from "./collectors/clusters.js";
import { getSlowQueriesForProcess, flattenSlowQueries } from "./collectors/slowQueries.js";
import { getSlowQueryNamespaces } from "./collectors/performanceAdvisor.js";
import { toCsv } from "./utils/csv.js";
import { analyzeSlowQueries, renderMarkdownReport } from "./analyze.js";
import { upsertSamples, closeStorage } from "./storage.js";

const args = parseArgs(process.argv.slice(2));

const {
  ATLAS_PUBLIC_KEY,
  ATLAS_PRIVATE_KEY,
  ATLAS_PROJECT_ID,
  ATLAS_CLUSTER_NAMES = "",
  ATLAS_DURATION_MS,
  ATLAS_SINCE_MS,
  ATLAS_NAMESPACES = "",
  ATLAS_OP_TYPES = "",
  ATLAS_TOP_N = "20",
  OUTPUT_DIR = "./output",
} = process.env;

async function main() {
  if (!ATLAS_PROJECT_ID) throw new Error("Missing ATLAS_PROJECT_ID in .env");

  const clusterNames = (args.cluster ? [args.cluster] : ATLAS_CLUSTER_NAMES.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!clusterNames.length) {
    throw new Error("Missing cluster name(s). Set ATLAS_CLUSTER_NAMES in .env or pass --cluster <name>.");
  }

  const namespaces = (args.namespaces ?? ATLAS_NAMESPACES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const opTypeFilter = (args["op-types"] ?? ATLAS_OP_TYPES)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const topN = Number(args.top ?? ATLAS_TOP_N);

  const opts = {
    durationMs: numberOrUndefined(args.duration ?? ATLAS_DURATION_MS),
    sinceMs: numberOrUndefined(args.since ?? ATLAS_SINCE_MS),
    namespaces: namespaces.length ? namespaces : undefined,
  };

  const client = new AtlasClient(ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY);
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const clusterName of clusterNames) {
    console.log(`\n=== Query Profiler: ${clusterName} ===`);
    const outDir = path.join(OUTPUT_DIR, clusterName, `profiler-${runTimestamp}`);
    await fs.mkdir(outDir, { recursive: true });

    const cluster = await getCluster(client, ATLAS_PROJECT_ID, clusterName);
    const processIds = extractProcessIds(cluster);
    console.log(`Hosts: ${processIds.join(", ")}`);

    let allEntries = [];
    for (const processId of processIds) {
      try {
        const entries = await getSlowQueriesForProcess(client, ATLAS_PROJECT_ID, processId, opts);
        console.log(`  [${processId}] ${entries.length} slow query samples`);
        allEntries = allEntries.concat(entries);
      } catch (err) {
        console.warn(`  [${processId}] error: ${err.message}`);
      }
    }

    let flattened = flattenSlowQueries(allEntries);
    if (opTypeFilter.length) {
      flattened = flattened.filter((r) => opTypeFilter.includes((r.opType ?? "").toLowerCase()));
    }

    await fs.writeFile(path.join(outDir, "slow-queries-raw.json"), JSON.stringify(allEntries, null, 2));
    // exactQueryObj is kept structured in JSON outputs; the CSV uses the
    // pre-stringified `exactQuery` column instead to keep cells single-line-friendly.
    await fs.writeFile(
      path.join(outDir, "slow-queries.csv"),
      toCsv(flattened, ["exactQueryObj", "rawLine"]),
      "utf8"
    );
    await fs.writeFile(
      path.join(outDir, "slow-queries-flattened.json"),
      JSON.stringify(flattened, null, 2)
    );

    const namespacesWithSlowQueries = {};
    for (const processId of processIds) {
      try {
        namespacesWithSlowQueries[processId] = await getSlowQueryNamespaces(client, ATLAS_PROJECT_ID, processId, opts);
      } catch (err) {
        console.warn(`  [${processId}] namespaces error: ${err.message}`);
      }
    }
    await fs.writeFile(
      path.join(outDir, "namespaces.json"),
      JSON.stringify(namespacesWithSlowQueries, null, 2)
    );

    const analysis = analyzeSlowQueries(flattened, { topN });
    await fs.writeFile(path.join(outDir, "analysis.json"), JSON.stringify(analysis, null, 2));

    const report = renderMarkdownReport(clusterName, analysis);
    await fs.writeFile(path.join(outDir, "report.md"), report, "utf8");

    printConsoleSummary(analysis);
    console.log(`\nArtifacts written to: ${outDir}`);
    console.log(`Open ${path.join(outDir, "report.md")} for the human-readable summary.`);

    // Optional: persist into MongoDB so the local UI (see server/) can
    // filter/sort/drill-down without re-hitting the Atlas Admin API.
    if (process.env.ATLAS_STORAGE_URI) {
      try {
        const { upserted, matched } = await upsertSamples(flattened, {
          sourceCluster: clusterName,
          runId: runTimestamp,
        });
        console.log(`Stored in MongoDB: ${upserted} new, ${matched} updated (deduped by sampleId).`);
      } catch (err) {
        console.warn(`Storage write failed (continuing anyway): ${err.message}`);
      }
    } else {
      console.log("ATLAS_STORAGE_URI not set — skipping MongoDB storage (file artifacts only).");
    }
  }
}

function printConsoleSummary(analysis) {
  const t = analysis.totals;
  console.log("\n--- Summary ---");
  console.log(`Slow query samples : ${t.totalSlowQueries}`);
  console.log(`COLLSCANs          : ${t.collscanCount} (${t.collscanRatePct}%)`);
  console.log(`In-memory sorts    : ${t.inMemorySortCount}`);
  console.log(`No index coverage  : ${t.noIndexCoverageCount}`);
  console.log(`Exec time ms (avg/p50/p95/p99): ${t.avgExecutionTimeMs}/${t.p50ExecutionTimeMs}/${t.p95ExecutionTimeMs}/${t.p99ExecutionTimeMs}`);
  console.log("\nTop namespaces by slow-query count:");
  for (const n of analysis.byNamespace.slice(0, 5)) {
    console.log(`  ${n.namespace}: ${n.count} (avg ${n.avgExecutionTimeMs}ms, ${n.collscanCount} COLLSCAN)`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function numberOrUndefined(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

main()
  .catch((err) => {
    console.error("\nFailed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => closeStorage());
