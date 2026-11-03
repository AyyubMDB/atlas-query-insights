/**
 * Seeds the storage collection with synthetic slow-query samples so you can
 * try the UI (`npm run ui`) immediately, before wiring up real Atlas Admin
 * API credentials. Safe to re-run — samples are upserted by sampleId.
 *
 * Usage: npm run seed:demo
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { upsertSamples, closeStorage } from "../src/storage.js";

const CLUSTER = "DemoCluster";
const NAMESPACES = ["shop.orders", "shop.users", "shop.products"];
const OP_TYPES = ["query", "command", "update"];
const APPS = ["checkout-service", "billing-service", "admin-portal"];
const SAMPLE_COUNT = 80;

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function buildRawLine(ns, filter, planSummary, appName, loggedAt) {
  return JSON.stringify({
    t: { $date: loggedAt.toISOString() },
    s: "I",
    c: "COMMAND",
    ctx: `conn${randomInt(1, 999)}`,
    msg: "Slow query",
    attr: {
      ns,
      command: { find: ns.split(".")[1], filter, sort: { createdAt: -1 }, limit: 50 },
      planSummary,
      appName,
    },
  });
}

async function main() {
  const rows = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const namespace = NAMESPACES[i % NAMESPACES.length];
    const collection = namespace.split(".")[1];
    const isScan = Math.random() < 0.3;
    const appName = APPS[randomInt(0, APPS.length)];
    const loggedAt = new Date(Date.now() - randomInt(0, 6 * 60 * 60 * 1000));
    const filter = { status: "pending", region: `us-${i % 4}`, amount: { $gt: i } };
    const planSummary = isScan ? "COLLSCAN" : "IXSCAN { status: 1 }";
    const execMs = isScan ? randomInt(500, 3500) : randomInt(20, 220);
    const docsExamined = isScan ? randomInt(10000, 400000) : randomInt(50, 250);
    const docsReturned = randomInt(5, 45);
    const rawLine = buildRawLine(namespace, filter, planSummary, appName, loggedAt);

    rows.push({
      sampleId: createHash("sha1").update(`demo-host:27017|${rawLine}|${i}`).digest("hex"),
      processId: "demo-host:27017",
      loggedAt,
      namespace,
      opType: OP_TYPES[i % OP_TYPES.length],
      operationExecutionTimeMs: execMs,
      docsExamined,
      docsReturned,
      docsExaminedReturnedRatio: +(docsExamined / docsReturned).toFixed(2),
      keysExamined: isScan ? 0 : docsExamined,
      hasSort: Math.random() < 0.2,
      hasIndexCoverage: !isScan,
      planSummary,
      isCollectionScan: isScan,
      appName,
      exactQuery: JSON.stringify({ find: collection, filter }),
      exactQueryObj: { find: collection, filter, sort: { createdAt: -1 }, limit: 50 },
      rawLine,
    });
  }

  const result = await upsertSamples(rows, { sourceCluster: CLUSTER, runId: "seed-demo" });
  console.log(`Seeded "${CLUSTER}": ${result.upserted} new, ${result.matched} updated.`);
  console.log(`Run "npm run ui" and select "${CLUSTER}" from the cluster dropdown.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => closeStorage());
