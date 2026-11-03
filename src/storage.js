/**
 * Storage layer that persists flattened Query Profiler samples into a
 * MongoDB collection (your own Atlas cluster/database — separate from the
 * customer's cluster being profiled) so the local UI can query/filter/sort
 * them without re-hitting the Atlas Admin API every time.
 *
 * Samples are UPSERTed by `sampleId` (a hash of processId + raw log line),
 * so re-running the collector over an overlapping time window is safe and
 * won't create duplicate rows.
 */
import { MongoClient } from "mongodb";

let client;
let collectionPromise;

function requireUri() {
  const uri = process.env.ATLAS_STORAGE_URI;
  if (!uri) {
    throw new Error(
      "ATLAS_STORAGE_URI is not set in .env — this is the connection string for the " +
        "cluster you want to STORE collected profiler data in (not the customer's cluster)."
    );
  }
  return uri;
}

export async function getSamplesCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      client = new MongoClient(requireUri(), { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const dbName = process.env.ATLAS_STORAGE_DB || "atlas_query_insights";
      const collName = process.env.ATLAS_STORAGE_COLLECTION || "slow_query_samples";
      const db = client.db(dbName);
      const coll = db.collection(collName);
      await coll.createIndexes([
        { key: { sourceCluster: 1, namespace: 1 } },
        { key: { sourceCluster: 1, opType: 1 } },
        { key: { sourceCluster: 1, isCollectionScan: 1 } },
        { key: { sourceCluster: 1, operationExecutionTimeMs: -1 } },
        { key: { sourceCluster: 1, loggedAt: -1 } },
        { key: { sourceCluster: 1, collectedAt: -1 } },
      ]);
      return coll;
    })();
  }
  return collectionPromise;
}

/**
 * @param {object[]} rows flattened slow query rows (see collectors/slowQueries.js)
 * @param {{ sourceCluster: string, runId: string }} meta
 */
export async function upsertSamples(rows, meta) {
  if (!rows.length) return { upserted: 0, matched: 0 };
  const coll = await getSamplesCollection();
  const collectedAt = new Date();
  const ops = rows.map((row) => ({
    updateOne: {
      filter: { _id: row.sampleId },
      update: {
        $set: { ...row, ...meta, collectedAt },
        $setOnInsert: { firstSeenAt: collectedAt },
      },
      upsert: true,
    },
  }));
  const result = await coll.bulkWrite(ops, { ordered: false });
  return { upserted: result.upsertedCount, matched: result.matchedCount };
}

export async function closeStorage() {
  await client?.close();
}
