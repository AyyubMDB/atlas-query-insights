/**
 * Local Query Profiler UI — a small Express server that reads previously
 * collected slow-query samples out of MongoDB (see src/storage.js /
 * src/profiler.js) and exposes them through a filterable, sortable API +
 * a static single-page frontend (server/public/) styled after the Atlas
 * Query Profiler experience: scatter chart, sortable table, detail panel.
 *
 * This process is READ ONLY against the storage collection — it never
 * talks to the Atlas Admin API itself. Run `npm run profile` (with
 * ATLAS_STORAGE_URI set) first to populate data, then `npm run ui`.
 */
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSamplesCollection } from "../src/storage.js";
import { analyzeSlowQueries } from "../src/analyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.UI_PORT || 4000;

const SORTABLE_FIELDS = new Set([
  "loggedAt",
  "collectedAt",
  "operationExecutionTimeMs",
  "docsExamined",
  "docsReturned",
  "docsExaminedReturnedRatio",
  "keysExamined",
  "keysExaminedReturnedRatio",
  "numYields",
  "namespace",
  "opType",
]);

const STATS_SAMPLE_CAP = 10000; // cap for in-process analysis/chart to keep the UI snappy

/** Builds a MongoDB filter document from shared query-string params. */
function buildFilter(query) {
  const filter = {};
  if (query.cluster) filter.sourceCluster = query.cluster;

  const csv = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
  const namespaces = csv(query.namespace);
  if (namespaces.length) filter.namespace = { $in: namespaces };

  const opTypes = csv(query.opType);
  if (opTypes.length) filter.opType = { $in: opTypes };

  const appNames = csv(query.appName);
  if (appNames.length) filter.appName = { $in: appNames };

  const hosts = csv(query.host);
  if (hosts.length) filter.processId = { $in: hosts };

  if (query.collscanOnly === "true") filter.isCollectionScan = true;
  if (query.noIndexOnly === "true") filter.hasIndexCoverage = false;

  if (query.from || query.to) {
    filter.loggedAt = {};
    if (query.from) filter.loggedAt.$gte = new Date(Number(query.from) || query.from);
    if (query.to) filter.loggedAt.$lte = new Date(Number(query.to) || query.to);
  }

  if (query.search) {
    const re = new RegExp(escapeRegExp(query.search), "i");
    filter.$or = [{ exactQuery: re }, { namespace: re }, { appName: re }];
  }

  return filter;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/** Distinct clusters available in storage (populates the cluster dropdown). */
app.get("/api/clusters", async (req, res, next) => {
  try {
    const coll = await getSamplesCollection();
    const clusters = await coll.distinct("sourceCluster");
    res.json({ clusters });
  } catch (err) {
    next(err);
  }
});

/** Distinct facet values (for filter dropdowns), scoped to a cluster. */
app.get("/api/facets", async (req, res, next) => {
  try {
    const coll = await getSamplesCollection();
    const match = req.query.cluster ? { sourceCluster: req.query.cluster } : {};
    const [namespaces, opTypes, appNames, hosts] = await Promise.all([
      coll.distinct("namespace", match),
      coll.distinct("opType", match),
      coll.distinct("appName", match),
      coll.distinct("processId", match),
    ]);
    res.json({
      namespaces: namespaces.filter(Boolean).sort(),
      opTypes: opTypes.filter(Boolean).sort(),
      appNames: appNames.filter(Boolean).sort(),
      hosts: hosts.filter(Boolean).sort(),
    });
  } catch (err) {
    next(err);
  }
});

/** Paginated, filtered, sorted sample listing — backs the main table. */
app.get("/api/samples", async (req, res, next) => {
  try {
    const coll = await getSamplesCollection();
    const filter = buildFilter(req.query);

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const sortBy = SORTABLE_FIELDS.has(req.query.sortBy) ? req.query.sortBy : "loggedAt";
    const sortDir = req.query.sortDir === "asc" ? 1 : -1;

    const [rows, total] = await Promise.all([
      coll
        .find(filter, { projection: { rawLine: 0 } }) // exclude heavy field from list view
        .sort({ [sortBy]: sortDir })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      coll.countDocuments(filter),
    ]);

    res.json({ rows, total, page, pageSize, sortBy, sortDir: sortDir === 1 ? "asc" : "desc" });
  } catch (err) {
    next(err);
  }
});

/** Single sample detail — includes the full raw mongod log line. */
app.get("/api/samples/:id", async (req, res, next) => {
  try {
    const coll = await getSamplesCollection();
    const doc = await coll.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: "Sample not found" });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

/**
 * Aggregate stats + scatter-chart points for the current filter set.
 * Reuses the same analyze.js logic that produces report.md, so the UI and
 * the Markdown report always agree with each other.
 */
app.get("/api/stats", async (req, res, next) => {
  try {
    const coll = await getSamplesCollection();
    const filter = buildFilter(req.query);
    const topN = Math.min(100, Math.max(1, Number(req.query.top) || 20));

    const rows = await coll
      .find(filter, {
        projection: {
          namespace: 1,
          opType: 1,
          operationExecutionTimeMs: 1,
          docsExamined: 1,
          docsReturned: 1,
          docsExaminedReturnedRatio: 1,
          keysExamined: 1,
          hasSort: 1,
          hasIndexCoverage: 1,
          planSummary: 1,
          isCollectionScan: 1,
          appName: 1,
          loggedAt: 1,
          exactQuery: 1,
          exactQueryObj: 1,
        },
      })
      .sort({ loggedAt: -1 })
      .limit(STATS_SAMPLE_CAP)
      .toArray();

    const analysis = analyzeSlowQueries(rows, { topN });
    const scatter = rows.map((r) => ({
      sampleId: r._id,
      loggedAt: r.loggedAt,
      operationExecutionTimeMs: r.operationExecutionTimeMs,
      isCollectionScan: r.isCollectionScan,
      namespace: r.namespace,
      opType: r.opType,
    }));

    res.json({ analysis, scatter, sampledCount: rows.length, cappedAt: STATS_SAMPLE_CAP });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// Bound to localhost only (not 0.0.0.0) — this is a single-user, laptop-only
// tool with no auth layer, so it should never be reachable from the network.
// Override with UI_HOST if you deliberately need otherwise (add auth first).
const HOST = process.env.UI_HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Atlas Query Profiler UI running at http://localhost:${PORT} (bound to ${HOST} only)`);
});
