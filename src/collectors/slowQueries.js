/**
 * Pulls slow query log entries for a single mongod/mongos process.
 * This is the same underlying data that powers both the "Performance
 * Advisor" and "Query Profiler" (Query Insights) tabs in the Atlas UI.
 *
 * Docs: https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-listslowqueries
 */
import { createHash } from "node:crypto";

/**
 * @param {import('../atlasClient.js').AtlasClient} client
 * @param {string} groupId
 * @param {string} processId host:port
 * @param {{ durationMs?: number, sinceMs?: number, namespaces?: string[] }} opts
 */
export async function getSlowQueriesForProcess(client, groupId, processId, opts = {}) {
  const result = await client.get(
    `/groups/${groupId}/processes/${encodeURIComponent(processId)}/performanceAdvisor/slowQueryLogs`,
    {
      duration: opts.durationMs,
      since: opts.sinceMs,
      namespaces: opts.namespaces,
      nLogs: 20000,
      includeMetrics: true,
      includeReplicaState: true,
      includeOpType: true,
    }
  );
  return (result?.slowQueries ?? []).map((entry) => ({ ...entry, processId }));
}

/**
 * The `line` field returned by the API is the raw mongod/mongos JSON log
 * entry (standard MongoDB structured log format: { t, s, c, id, ctx, msg,
 * attr }). For query/command-type slow operations, `attr.command` (or
 * `attr.originatingCommand` for getMore on a cursor) IS the exact query
 * document that ran — filter, pipeline, sort, projection, update spec, etc.
 * Older-style op logs may instead carry `attr.query` / `attr.updateobj`.
 *
 * NOTE: seeing real filter *values* here (rather than redacted structure)
 * requires the API key to also have `Project Data Access Read Only` (or
 * `Project Observability Viewer`) in addition to `Project Read Only`. See
 * README "Setup" section.
 */
export function parseLogLine(line) {
  if (typeof line !== "string") return {};
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {}; // not JSON-formatted (older log format) — nothing structured to extract
  }
  const attr = parsed?.attr ?? {};
  const command = attr.command ?? attr.originatingCommand ?? attr.query ?? attr.updateobj;
  const rawTimestamp = parsed?.t?.$date ?? parsed?.t;
  return {
    planSummary: attr.planSummary ?? parsed?.planSummary,
    command,
    queryHash: attr.queryHash,
    planCacheKey: attr.planCacheKey,
    appName: attr.appName,
    remote: attr.remote,
    durationMillis: attr.durationMillis,
    ctx: parsed?.ctx,
    // The actual wall-clock time the operation was logged by mongod — this is
    // what should drive a time-based scatter chart, not "when we collected it".
    loggedAt: rawTimestamp ? new Date(rawTimestamp) : undefined,
  };
}

/**
 * Flattens the raw slow query entries (including nested `metrics`) into
 * plain rows suitable for CSV export / spreadsheet analysis.
 */
const MAX_STORED_RAW_LINE_CHARS = 20000;

export function flattenSlowQueries(entries) {
  return entries.map((e) => {
    const m = e.metrics ?? {};
    const { planSummary, command, queryHash, appName, remote, ctx, loggedAt } = parseLogLine(e.line);
    const rawLineTruncated = typeof e.line === "string" && e.line.length > MAX_STORED_RAW_LINE_CHARS;
    return {
      // Stable id so repeated collection runs over overlapping time windows
      // can be UPSERTed into storage instead of creating duplicate rows.
      sampleId: createHash("sha1").update(`${e.processId}|${e.line ?? ""}`).digest("hex"),
      processId: e.processId,
      loggedAt,
      ctx,
      namespace: e.namespace,
      opType: e.opType,
      replicaState: e.replicaState,
      operationExecutionTimeMs: m.operationExecutionTime,
      docsExamined: m.docsExamined,
      docsReturned: m.docsReturned,
      docsExaminedReturnedRatio: m.docsExaminedReturnedRatio,
      keysExamined: m.keysExamined,
      keysExaminedReturnedRatio: m.keysExaminedReturnedRatio,
      numYields: m.numYields,
      hasSort: m.hasSort,
      hasIndexCoverage: m.hasIndexCoverage, // == "Uses Index" column in the Query Profiler UI
      hasRerank: m.hasRerank,
      hasAutoEmbedding: m.hasAutoEmbedding,
      fromUserConnection: m.fromUserConnection,
      tokensUsed: m.tokensUsed,
      responseLengthBytes: m.responseLength,
      planSummary,
      isCollectionScan: planSummary?.startsWith("COLLSCAN") ?? undefined,
      appName,
      remote,
      queryHash,
      // The exact query/command that executed (filter, pipeline, sort, update spec, etc.)
      exactQuery: command ? JSON.stringify(command) : undefined,
      exactQueryObj: command, // kept for JSON output; stripped for CSV automatically (see utils/csv.js usage)
      // Raw mongod log line, for a "just like Atlas's detail panel" query-log view.
      // Truncated defensively so a pathological entry can't bloat storage.
      rawLine: rawLineTruncated ? e.line.slice(0, MAX_STORED_RAW_LINE_CHARS) : e.line,
      rawLineTruncated,
    };
  });
}
