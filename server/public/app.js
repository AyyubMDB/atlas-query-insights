const state = {
  cluster: "",
  namespace: [],
  opType: [],
  appName: [],
  host: [],
  collscanOnly: false,
  noIndexOnly: false,
  search: "",
  page: 1,
  pageSize: 25,
  sortBy: "loggedAt",
  sortDir: "desc",
};

let scatterChart;

// Distinct, reasonably colorblind-friendly categorical palette (d3
// category10 + a few extras) for coloring the scatter chart by namespace.
const NAMESPACE_PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#bcbd22",
  "#17becf",
  "#00ed64", // MongoDB green
  "#f4a5ae",
  "#6b8ef2",
];

/** Deterministic namespace -> color mapping (stable across reloads/filters). */
function colorForNamespace(namespace) {
  let hash = 0;
  const str = namespace || "";
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % NAMESPACE_PALETTE.length;
  return NAMESPACE_PALETTE[idx];
}

const el = (id) => document.getElementById(id);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function buildFilterQuery(extra = {}) {
  const p = new URLSearchParams();
  if (state.cluster) p.set("cluster", state.cluster);
  if (state.namespace.length) p.set("namespace", state.namespace.join(","));
  if (state.opType.length) p.set("opType", state.opType.join(","));
  if (state.appName.length) p.set("appName", state.appName.join(","));
  if (state.host.length) p.set("host", state.host.join(","));
  if (state.collscanOnly) p.set("collscanOnly", "true");
  if (state.noIndexOnly) p.set("noIndexOnly", "true");
  if (state.search) p.set("search", state.search);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

async function init() {
  const { clusters } = await fetchJson("/api/clusters");
  const select = el("clusterSelect");
  select.innerHTML = clusters.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  state.cluster = clusters[0] || "";
  select.value = state.cluster;

  select.addEventListener("change", async () => {
    state.cluster = select.value;
    state.page = 1;
    await loadFacets();
    await refreshAll();
  });

  el("applyBtn").addEventListener("click", async () => {
    readFiltersFromDom();
    state.page = 1;
    await refreshAll();
  });
  el("resetBtn").addEventListener("click", async () => {
    resetFilters();
    await refreshAll();
  });
  el("refreshBtn").addEventListener("click", refreshAll);

  el("pageSizeSelect").value = String(state.pageSize);
  el("pageSizeSelect").addEventListener("change", async (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    await loadSamples();
  });
  el("prevPageBtn").addEventListener("click", async () => {
    if (state.page > 1) {
      state.page--;
      await loadSamples();
    }
  });
  el("nextPageBtn").addEventListener("click", async () => {
    state.page++;
    await loadSamples();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", async () => {
      const field = th.dataset.sort;
      if (state.sortBy === field) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortBy = field;
        state.sortDir = "desc";
      }
      state.page = 1;
      await loadSamples();
    });
  });

  el("closeDetailBtn").addEventListener("click", closeDetail);
  el("detailOverlay").addEventListener("click", closeDetail);

  if (state.cluster) {
    await loadFacets();
    await refreshAll();
  } else {
    renderEmptyState();
  }
}

function renderEmptyState() {
  el("samplesBody").innerHTML =
    '<tr><td colspan="10" class="empty-state">No clusters found in storage yet. Run `npm run profile` with ATLAS_STORAGE_URI set to collect data.</td></tr>';
  el("summaryCards").innerHTML = "";
}

function readFiltersFromDom() {
  state.namespace = getSelectedValues("namespaceFilter");
  state.opType = getSelectedValues("opTypeFilter");
  state.appName = getSelectedValues("appNameFilter");
  state.host = getSelectedValues("hostFilter");
  state.collscanOnly = el("collscanOnly").checked;
  state.noIndexOnly = el("noIndexOnly").checked;
  state.search = el("searchBox").value.trim();
}

function resetFilters() {
  state.namespace = [];
  state.opType = [];
  state.appName = [];
  state.host = [];
  state.collscanOnly = false;
  state.noIndexOnly = false;
  state.search = "";
  state.page = 1;
  ["namespaceFilter", "opTypeFilter", "appNameFilter", "hostFilter"].forEach((id) => {
    [...el(id).options].forEach((o) => (o.selected = false));
  });
  el("collscanOnly").checked = false;
  el("noIndexOnly").checked = false;
  el("searchBox").value = "";
}

function getSelectedValues(id) {
  return [...el(id).selectedOptions].map((o) => o.value);
}

async function loadFacets() {
  const { namespaces, opTypes, appNames, hosts } = await fetchJson(
    `/api/facets?cluster=${encodeURIComponent(state.cluster)}`
  );
  fillOptions("namespaceFilter", namespaces);
  fillOptions("opTypeFilter", opTypes);
  fillOptions("appNameFilter", appNames);
  fillOptions("hostFilter", hosts);
}

function fillOptions(id, values) {
  el(id).innerHTML = values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

async function refreshAll() {
  await Promise.all([loadStats(), loadSamples()]);
}

async function loadStats() {
  const qs = buildFilterQuery({ top: 20 });
  const { analysis, scatter, sampledCount, cappedAt } = await fetchJson(`/api/stats?${qs}`);
  renderSummary(analysis, sampledCount, cappedAt);
  renderScatter(scatter);
}

function renderSummary(analysis, sampledCount, cappedAt) {
  const t = analysis.totals;
  const cards = [
    { label: "Total Samples", value: t.totalSlowQueries, cls: "" },
    { label: "COLLSCAN Rate", value: `${t.collscanRatePct}%`, cls: t.collscanRatePct > 20 ? "danger" : "" },
    { label: "In-Memory Sorts", value: t.inMemorySortCount, cls: t.inMemorySortCount > 0 ? "warn" : "" },
    { label: "No Index Coverage", value: t.noIndexCoverageCount, cls: t.noIndexCoverageCount > 0 ? "warn" : "" },
    { label: "Avg Exec (ms)", value: t.avgExecutionTimeMs, cls: "" },
    { label: "p95 Exec (ms)", value: t.p95ExecutionTimeMs, cls: "" },
    { label: "p99 Exec (ms)", value: t.p99ExecutionTimeMs, cls: "" },
  ];
  el("summaryCards").innerHTML = cards
    .map(
      (c) => `<div class="card ${c.cls}"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`
    )
    .join("");
  if (sampledCount >= cappedAt) {
    el("summaryCards").innerHTML += `<div class="card"><div class="value">⚠</div><div class="label">Stats capped at ${cappedAt} most recent samples — narrow filters for full accuracy</div></div>`;
  }
}

/**
 * Each point carries its full sample metadata (not just x/y) so tooltip
 * callbacks and the click handler can read it back via `context.raw`
 * without needing a separate parallel lookup array.
 */
function renderScatter(scatter) {
  const byNamespace = new Map();
  for (const s of scatter) {
    const key = s.namespace ?? "(unknown)";
    if (!byNamespace.has(key)) byNamespace.set(key, []);
    byNamespace.get(key).push({
      x: new Date(s.loggedAt).getTime(),
      y: s.operationExecutionTimeMs,
      sampleId: s.sampleId,
      namespace: s.namespace,
      opType: s.opType,
      loggedAt: s.loggedAt,
      isCollectionScan: s.isCollectionScan,
    });
  }

  // Sorted for a stable, predictable legend order.
  const datasets = [...byNamespace.keys()].sort().map((namespace) => {
    const color = colorForNamespace(namespace);
    return {
      label: namespace,
      data: byNamespace.get(namespace),
      backgroundColor: color,
      // COLLSCAN points get a thick red outline layered on top of their
      // namespace color, so both signals stay visible at once.
      borderColor: (ctx) => (ctx.raw?.isCollectionScan ? "#ff5c5c" : color),
      borderWidth: (ctx) => (ctx.raw?.isCollectionScan ? 2 : 0),
      pointRadius: (ctx) => (ctx.raw?.isCollectionScan ? 5 : 4),
      pointHoverRadius: 7,
    };
  });

  const ctx2d = el("scatterChart").getContext("2d");
  if (scatterChart) scatterChart.destroy();
  scatterChart = new Chart(ctx2d, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      font: { family: "'Euclid Circular A', 'Poppins', sans-serif" },
      scales: {
        x: {
          type: "linear",
          ticks: { color: "#8b98a5", callback: (v) => new Date(v).toLocaleTimeString() },
          grid: { color: "#202a35" },
          title: { display: true, text: "Time", color: "#8b98a5" },
        },
        y: {
          ticks: { color: "#8b98a5", font: { family: "'Source Code Pro', monospace" } },
          grid: { color: "#202a35" },
          title: { display: true, text: "Execution Time (ms)", color: "#8b98a5" },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "#e6edf3", boxWidth: 12, font: { size: 11 } },
          // Clicking a legend entry isolates that namespace (Chart.js
          // toggles dataset visibility by default).
        },
        tooltip: {
          callbacks: {
            title: (items) => (items[0]?.raw?.loggedAt ? new Date(items[0].raw.loggedAt).toLocaleString() : ""),
            label: (item) => {
              const r = item.raw;
              return [`Namespace: ${r.namespace}`, `Execution Time: ${r.y} ms`, `Op: ${r.opType}`];
            },
          },
        },
      },
      onClick: (evt) => {
        const points = scatterChart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
        if (points.length) {
          const { datasetIndex, index } = points[0];
          const point = scatterChart.data.datasets[datasetIndex].data[index];
          if (point?.sampleId) openDetail(point.sampleId);
        }
      },
    },
  });
}

async function loadSamples() {
  const qs = buildFilterQuery({
    page: state.page,
    pageSize: state.pageSize,
    sortBy: state.sortBy,
    sortDir: state.sortDir,
  });
  const { rows, total } = await fetchJson(`/api/samples?${qs}`);
  renderTable(rows);
  renderPager(total);
  updateSortIndicators();
}

function renderTable(rows) {
  if (!rows.length) {
    el("samplesBody").innerHTML = '<tr><td colspan="10" class="empty-state">No matching slow queries.</td></tr>';
    return;
  }
  el("samplesBody").innerHTML = rows
    .map((r) => {
      const planBadge = r.isCollectionScan
        ? `<span class="badge collscan">COLLSCAN</span>`
        : r.planSummary
        ? `<span class="badge ixscan">${escapeHtml(truncate(r.planSummary, 24))}</span>`
        : "";
      const indexBadge =
        r.hasIndexCoverage === false
          ? `<span class="badge no">✕</span>`
          : r.hasIndexCoverage === true
          ? `<span class="badge yes">✓</span>`
          : "";
      return `<tr data-id="${r._id}">
        <td class="num">${r.loggedAt ? new Date(r.loggedAt).toLocaleString() : ""}</td>
        <td><span class="ns-dot" style="background:${colorForNamespace(r.namespace)}"></span>${escapeHtml(r.namespace ?? "")}</td>
        <td>${escapeHtml(r.opType ?? "")}</td>
        <td class="num">${r.operationExecutionTimeMs ?? ""}</td>
        <td class="num">${r.docsExamined ?? ""}</td>
        <td class="num">${r.docsReturned ?? ""}</td>
        <td class="num">${formatRatio(r.docsExaminedReturnedRatio)}</td>
        <td>${planBadge}</td>
        <td>${indexBadge}</td>
        <td>${escapeHtml(r.appName ?? "")}</td>
      </tr>`;
    })
    .join("");

  el("samplesBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openDetail(tr.dataset.id));
  });
}

function renderPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  el("pageIndicator").textContent = `Page ${state.page} of ${totalPages} (${total} total)`;
  el("prevPageBtn").disabled = state.page <= 1;
  el("nextPageBtn").disabled = state.page >= totalPages;
}

function updateSortIndicators() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.textContent = th.textContent.replace(/ [▲▼]$/, "");
    if (th.dataset.sort === state.sortBy) {
      th.textContent += state.sortDir === "asc" ? " ▲" : " ▼";
    }
  });
}

async function openDetail(id) {
  el("detailPanel").classList.remove("hidden");
  el("detailOverlay").classList.remove("hidden");
  el("detailContent").innerHTML = "Loading…";
  try {
    const s = await fetchJson(`/api/samples/${encodeURIComponent(id)}`);
    renderDetail(s);
  } catch (err) {
    el("detailContent").innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderDetail(s) {
  // [label, value, isNumeric] — numeric/unit values use Source Code Pro
  // per MongoDB's typography guidelines (mongodb.design/component/typography).
  const fields = [
    ["Namespace", s.namespace, false],
    ["Operation", s.opType, false],
    ["Host", s.processId, false],
    ["Logged At", s.loggedAt ? new Date(s.loggedAt).toLocaleString() : "", true],
    ["Execution Time", `${s.operationExecutionTimeMs ?? "?"} ms`, true],
    ["Plan Summary", s.planSummary, false],
    ["Docs Examined", s.docsExamined, true],
    ["Docs Returned", s.docsReturned, true],
    ["Docs Examined:Returned Ratio", formatRatio(s.docsExaminedReturnedRatio), true],
    ["Keys Examined", s.keysExamined, true],
    ["Keys Examined:Returned Ratio", formatRatio(s.keysExaminedReturnedRatio), true],
    ["Uses Index (hasIndexCoverage)", boolLabel(s.hasIndexCoverage), false],
    ["In-Memory Sort (hasSort)", boolLabel(s.hasSort), false],
    ["Num Yields", s.numYields, true],
    ["Response Length", s.responseLengthBytes ? `${s.responseLengthBytes} bytes` : "", true],
    ["Tokens Used ($rerank)", s.tokensUsed, true],
    ["App Name", s.appName, false],
    ["Replica State", s.replicaState, false],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");

  const grid = fields
    .map(
      ([k, v, isNum]) =>
        `<div class="detail-field"><div class="k">${escapeHtml(k)}</div><div class="v${isNum ? " mono" : ""}">${escapeHtml(String(v))}</div></div>`
    )
    .join("");

  const exactQueryBlock = s.exactQueryObj
    ? `<pre>${escapeHtml(JSON.stringify(s.exactQueryObj, null, 2))}</pre>`
    : `<div class="empty-state">Exact query not available for this entry (older log format, or role lacks Project Data Access Read Only).</div>`;

  const rawLineBlock = s.rawLine
    ? `<pre>${escapeHtml(prettyIfJson(s.rawLine))}</pre>`
    : `<div class="empty-state">Raw log line not stored for this entry.</div>`;

  el("detailContent").innerHTML = `
    <div class="detail-grid">${grid}</div>
    <div class="detail-section">
      <h3>Exact Query Executed</h3>
      ${exactQueryBlock}
    </div>
    <div class="detail-section">
      <h3>Raw mongod Log Line</h3>
      ${rawLineBlock}
    </div>
  `;
}

function closeDetail() {
  el("detailPanel").classList.add("hidden");
  el("detailOverlay").classList.add("hidden");
}

function boolLabel(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "";
}
function formatRatio(v) {
  return typeof v === "number" ? v.toFixed(2) : "";
}
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}
function prettyIfJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="empty-state">Failed to initialize UI: ${err.message}. Is the server running with a valid ATLAS_STORAGE_URI?</div>`;
});
