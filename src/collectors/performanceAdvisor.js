/**
 * Cluster-level Performance Advisor endpoints: these summarize suggested
 * indexes (with sample queries + impact metrics), schema anti-pattern
 * advice, and unused/redundant index drop suggestions.
 */

/** https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-listclustersuggestedindexes */
export async function getSuggestedIndexes(client, groupId, clusterName, opts = {}) {
  return client.get(`/groups/${groupId}/clusters/${clusterName}/performanceAdvisor/suggestedIndexes`, {
    since: opts.sinceMs,
    until: opts.untilMs,
    namespaces: opts.namespaces,
  });
}

/** Schema anti-pattern advice (e.g. unbounded arrays, excessive fields, etc.) */
export async function getSchemaAdvice(client, groupId, clusterName) {
  return client.get(`/groups/${groupId}/clusters/${clusterName}/performanceAdvisor/schemaAdvice`);
}

/** Indexes Atlas believes are unused/redundant and safe to consider dropping. */
export async function getDropIndexSuggestions(client, groupId, clusterName) {
  return client.get(`/groups/${groupId}/clusters/${clusterName}/performanceAdvisor/dropIndexSuggestions`);
}

/** Namespaces (db.collection) that have experienced slow queries on a given host. */
export async function getSlowQueryNamespaces(client, groupId, processId, opts = {}) {
  return client.get(
    `/groups/${groupId}/processes/${encodeURIComponent(processId)}/performanceAdvisor/namespaces`,
    { duration: opts.durationMs, since: opts.sinceMs }
  );
}
