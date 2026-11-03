/**
 * Turns a flat list of slow-query rows (see collectors/slowQueries.js
 * `flattenSlowQueries`) into the same kind of rollups the Query Profiler UI
 * shows: totals, per-namespace / per-opType breakdowns, worst offenders by
 * execution time and by scan efficiency, and a COLLSCAN rate.
 */

function avg(nums) {
  const valid = nums.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function percentile(nums, p) {
  const valid = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const idx = Math.min(valid.length - 1, Math.floor((p / 100) * valid.length));
  return valid[idx];
}

export function analyzeSlowQueries(rows, { topN = 20 } = {}) {
  const total = rows.length;
  const collscans = rows.filter((r) => r.isCollectionScan);
  const noSort = rows.filter((r) => r.hasSort);
  const noIndexCoverage = rows.filter((r) => r.hasIndexCoverage === false);
  const execTimes = rows.map((r) => r.operationExecutionTimeMs);

  const byNamespace = groupBy(rows, (r) => r.namespace ?? "(unknown)");
  const byOpType = groupBy(rows, (r) => r.opType ?? "(unknown)");

  const namespaceStats = Object.entries(byNamespace)
    .map(([namespace, group]) => ({
      namespace,
      count: group.length,
      avgExecutionTimeMs: round(avg(group.map((r) => r.operationExecutionTimeMs))),
      p95ExecutionTimeMs: round(percentile(group.map((r) => r.operationExecutionTimeMs), 95)),
      collscanCount: group.filter((r) => r.isCollectionScan).length,
      avgDocsExaminedReturnedRatio: round(avg(group.map((r) => r.docsExaminedReturnedRatio))),
      noIndexCoverageCount: group.filter((r) => r.hasIndexCoverage === false).length,
    }))
    .sort((a, b) => b.count - a.count);

  const opTypeStats = Object.entries(byOpType)
    .map(([opType, group]) => ({
      opType,
      count: group.length,
      avgExecutionTimeMs: round(avg(group.map((r) => r.operationExecutionTimeMs))),
    }))
    .sort((a, b) => b.count - a.count);

  const topSlowest = [...rows]
    .sort((a, b) => (b.operationExecutionTimeMs ?? 0) - (a.operationExecutionTimeMs ?? 0))
    .slice(0, topN);

  const topByScanInefficiency = [...rows]
    .filter((r) => typeof r.docsExaminedReturnedRatio === "number")
    .sort((a, b) => b.docsExaminedReturnedRatio - a.docsExaminedReturnedRatio)
    .slice(0, topN);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalSlowQueries: total,
      collscanCount: collscans.length,
      collscanRatePct: total ? round((collscans.length / total) * 100) : 0,
      inMemorySortCount: noSort.length,
      noIndexCoverageCount: noIndexCoverage.length,
      avgExecutionTimeMs: round(avg(execTimes)),
      p50ExecutionTimeMs: round(percentile(execTimes, 50)),
      p95ExecutionTimeMs: round(percentile(execTimes, 95)),
      p99ExecutionTimeMs: round(percentile(execTimes, 99)),
    },
    byNamespace: namespaceStats,
    byOpType: opTypeStats,
    topSlowest,
    topByScanInefficiency,
  };
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ??= []).push(item);
    return acc;
  }, {});
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Renders the analysis as a human-readable Markdown report. */
export function renderMarkdownReport(clusterName, analysis) {
  const t = analysis.totals;
  const lines = [];
  lines.push(`# Query Profiler Report: ${clusterName}`);
  lines.push(`Generated: ${analysis.generatedAt}\n`);

  lines.push("## Summary");
  lines.push(`- Total slow query samples: **${t.totalSlowQueries}**`);
  lines.push(`- Collection scans (COLLSCAN): **${t.collscanCount}** (${t.collscanRatePct}%)`);
  lines.push(`- In-memory sorts (hasSort=true): **${t.inMemorySortCount}**`);
  lines.push(`- No index coverage: **${t.noIndexCoverageCount}**`);
  lines.push(
    `- Execution time (ms): avg=${t.avgExecutionTimeMs}, p50=${t.p50ExecutionTimeMs}, p95=${t.p95ExecutionTimeMs}, p99=${t.p99ExecutionTimeMs}\n`
  );

  lines.push("## By Namespace");
  lines.push("| Namespace | Count | Avg ms | p95 ms | COLLSCANs | Avg Docs Examined:Returned | No Index Coverage |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const n of analysis.byNamespace) {
    lines.push(
      `| ${n.namespace} | ${n.count} | ${n.avgExecutionTimeMs} | ${n.p95ExecutionTimeMs} | ${n.collscanCount} | ${n.avgDocsExaminedReturnedRatio} | ${n.noIndexCoverageCount} |`
    );
  }

  lines.push("\n## By Operation Type");
  lines.push("| Op Type | Count | Avg ms |");
  lines.push("|---|---|---|");
  for (const o of analysis.byOpType) {
    lines.push(`| ${o.opType} | ${o.count} | ${o.avgExecutionTimeMs} |`);
  }

  lines.push("\n## Top Slowest Queries");
  lines.push(renderQueryList(analysis.topSlowest, (q) => `${q.operationExecutionTimeMs} ms`));

  lines.push("\n## Worst Scan Efficiency (Docs Examined : Returned)");
  lines.push(
    renderQueryList(analysis.topByScanInefficiency, (q) => `ratio ${q.docsExaminedReturnedRatio}`)
  );

  return lines.join("\n");
}

/**
 * Renders a numbered list of queries with the exact query document in a
 * fenced code block — more readable than cramming full filter/pipeline
 * documents into a Markdown table cell.
 */
function renderQueryList(queries, headlineMetric) {
  if (!queries.length) return "_None._";
  return queries
    .map((q, i) => {
      const header = `**${i + 1}. ${q.namespace}** — ${q.opType} — ${headlineMetric(q)} — plan: \`${q.planSummary ?? "unknown"}\` — docsExamined/Returned: ${q.docsExamined}/${q.docsReturned}${q.appName ? ` — app: ${q.appName}` : ""}`;
      const queryBlock = q.exactQuery
        ? "```json\n" + JSON.stringify(q.exactQueryObj ?? JSON.parse(q.exactQuery), null, 2) + "\n```"
        : "_Exact query not available (older log format, or role lacks Project Data Access Read Only)._";
      return `${header}\n\n${queryBlock}`;
    })
    .join("\n\n");
}
