/**
 * Cluster lookup + helpers for turning an Atlas cluster into the list of
 * mongod/mongos "processId" values (host:port) that the per-host
 * Performance Advisor endpoints require.
 */

/**
 * @param {import('../atlasClient.js').AtlasClient} client
 * @param {string} groupId
 * @param {string} clusterName
 */
export async function getCluster(client, groupId, clusterName) {
  return client.get(`/groups/${groupId}/clusters/${clusterName}`);
}

/**
 * Extracts "host:port" pairs from a cluster's standard (non-SRV) connection
 * string, e.g.
 *   mongodb://host1:27017,host2:27017,host3:27017/?ssl=true&...
 * SRV-only connection strings don't enumerate individual hosts, which is why
 * we specifically use `connectionStrings.standard`.
 * @param {any} clusterDoc
 * @returns {string[]}
 */
export function extractProcessIds(clusterDoc) {
  const standard = clusterDoc?.connectionStrings?.standard;
  if (!standard) {
    throw new Error(
      `Cluster "${clusterDoc?.name}" has no connectionStrings.standard. ` +
        "It may still be provisioning, or you may need to fetch process IDs manually " +
        "with `node src/index.js --list-processes`."
    );
  }
  // mongodb://host1:27017,host2:27017,host3:27017/?params
  const afterScheme = standard.replace(/^mongodb(\+srv)?:\/\//, "");
  const hostsSection = afterScheme.split("/")[0];
  return hostsSection.split(",").map((h) => h.trim()).filter(Boolean);
}
