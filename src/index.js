import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { AtlasClient } from "./atlasClient.js";
import { getCluster, extractProcessIds } from "./collectors/clusters.js";
import { getSlowQueriesForProcess, flattenSlowQueries } from "./collectors/slowQueries.js";
import {
  getSuggestedIndexes,
  getSchemaAdvice,
  getDropIndexSuggestions,
  getSlowQueryNamespaces,
} from "./collectors/performanceAdvisor.js";
import { toCsv } from "./utils/csv.js";

const {
  ATLAS_PUBLIC_KEY,
  ATLAS_PRIVATE_KEY,
  ATLAS_PROJECT_ID,
  ATLAS_CLUSTER_NAMES = "",
  ATLAS_DURATION_MS,
  ATLAS_SINCE_MS,
  OUTPUT_DIR = "./output",
} = process.env;

async function main() {
  if (!ATLAS_PROJECT_ID) {
    throw new Error("Missing ATLAS_PROJECT_ID in .env");
  }
  const clusterNames = ATLAS_CLUSTER_NAMES.split(",").map((s) => s.trim()).filter(Boolean);
  if (!clusterNames.length) {
    throw new Error("Missing ATLAS_CLUSTER_NAMES in .env (comma separated)");
  }

  const client = new AtlasClient(ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY);

  // --list-processes debug helper: `node src/index.js --list-processes`
  if (process.argv.includes("--list-processes")) {
    for (const clusterName of clusterNames) {
      const cluster = await getCluster(client, ATLAS_PROJECT_ID, clusterName);
      console.log(`\nCluster: ${clusterName}`);
      console.log("Process IDs (host:port):", extractProcessIds(cluster));
    }
    return;
  }

  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const opts = {
    durationMs: ATLAS_DURATION_MS ? Number(ATLAS_DURATION_MS) : undefined,
    sinceMs: ATLAS_SINCE_MS ? Number(ATLAS_SINCE_MS) : undefined,
  };

  for (const clusterName of clusterNames) {
    console.log(`\n=== Collecting Query Insights for cluster "${clusterName}" ===`);
    const outDir = path.join(OUTPUT_DIR, clusterName, runTimestamp);
    await fs.mkdir(outDir, { recursive: true });

    const cluster = await getCluster(client, ATLAS_PROJECT_ID, clusterName);
    const processIds = extractProcessIds(cluster);
    console.log(`Found ${processIds.length} host(s):`, processIds);

    // 1. Suggested indexes (cluster-level: includes sample queries + impact)
    const suggestedIndexes = await getSuggestedIndexes(client, ATLAS_PROJECT_ID, clusterName, opts);
    await writeJson(outDir, "suggested-indexes.json", suggestedIndexes);
    console.log(
      `Suggested indexes: ${suggestedIndexes?.content?.suggestedIndexes?.length ?? 0}, ` +
        `query shapes analyzed: ${suggestedIndexes?.content?.shapes?.length ?? 0}`
    );

    // 2. Schema advice (anti-patterns)
    try {
      const schemaAdvice = await getSchemaAdvice(client, ATLAS_PROJECT_ID, clusterName);
      await writeJson(outDir, "schema-advice.json", schemaAdvice);
    } catch (err) {
      console.warn(`  schemaAdvice unavailable: ${err.message}`);
    }

    // 3. Drop index suggestions (unused/redundant indexes)
    try {
      const dropIndexSuggestions = await getDropIndexSuggestions(client, ATLAS_PROJECT_ID, clusterName);
      await writeJson(outDir, "drop-index-suggestions.json", dropIndexSuggestions);
    } catch (err) {
      console.warn(`  dropIndexSuggestions unavailable: ${err.message}`);
    }

    // 4. Slow query logs, per host, merged
    let allSlowQueries = [];
    for (const processId of processIds) {
      try {
        const entries = await getSlowQueriesForProcess(client, ATLAS_PROJECT_ID, processId, opts);
        console.log(`  [${processId}] slow query log entries: ${entries.length}`);
        allSlowQueries = allSlowQueries.concat(entries);
      } catch (err) {
        console.warn(`  [${processId}] slowQueryLogs error: ${err.message}`);
      }
    }
    await writeJson(outDir, "slow-queries-raw.json", allSlowQueries);
    const flattened = flattenSlowQueries(allSlowQueries);
    await fs.writeFile(path.join(outDir, "slow-queries.csv"), toCsv(flattened, ["exactQueryObj", "rawLine"]), "utf8");

    // 5. Namespaces with slow queries, per host (useful for scoping index work)
    const namespacesByHost = {};
    for (const processId of processIds) {
      try {
        namespacesByHost[processId] = await getSlowQueryNamespaces(client, ATLAS_PROJECT_ID, processId, opts);
      } catch (err) {
        console.warn(`  [${processId}] namespaces error: ${err.message}`);
      }
    }
    await writeJson(outDir, "slow-query-namespaces.json", namespacesByHost);

    printSummary(clusterName, flattened, suggestedIndexes);
    console.log(`Artifacts written to: ${outDir}`);
  }
}

async function writeJson(dir, filename, data) {
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

function printSummary(clusterName, flattenedSlowQueries, suggestedIndexes) {
  const collScans = flattenedSlowQueries.filter((q) => q.isCollectionScan).length;
  const avgMs =
    flattenedSlowQueries.reduce((sum, q) => sum + (q.operationExecutionTimeMs || 0), 0) /
    (flattenedSlowQueries.length || 1);

  console.log(`\n--- Summary: ${clusterName} ---`);
  console.log(`Slow query samples collected : ${flattenedSlowQueries.length}`);
  console.log(`  of which COLLSCAN          : ${collScans}`);
  console.log(`  avg execution time (ms)    : ${avgMs.toFixed(1)}`);
  console.log(`Suggested indexes           : ${suggestedIndexes?.content?.suggestedIndexes?.length ?? 0}`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exitCode = 1;
});
