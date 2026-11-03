/**
 * Deletes all stored samples for a given sourceCluster — handy for wiping
 * demo data or resetting a bad collection run.
 *
 * Usage: node scripts/clear-cluster.js DemoCluster
 */
import "dotenv/config";
import { getSamplesCollection, closeStorage } from "../src/storage.js";

const cluster = process.argv[2];

async function main() {
  if (!cluster) {
    throw new Error("Usage: node scripts/clear-cluster.js <sourceCluster>");
  }
  const coll = await getSamplesCollection();
  const result = await coll.deleteMany({ sourceCluster: cluster });
  console.log(`Deleted ${result.deletedCount} sample(s) for cluster "${cluster}".`);
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => closeStorage());
