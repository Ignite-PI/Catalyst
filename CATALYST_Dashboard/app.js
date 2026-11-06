/* ============================================================
   CATALYST Inventory Command Center — app.js
   Data Engine + Chart.js Visualizations
   ============================================================ */

'use strict';

// ── Global Chart.js Defaults — Executive Light Theme ───────
Chart.defaults.color = '#7B74A0';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.plugins.legend.display = false;
// Register datalabels globally but default OFF; opt-in per chart
Chart.register(ChartDataLabels);
Chart.defaults.set('plugins.datalabels', { display: false });
Chart.defaults.plugins.tooltip.backgroundColor = '#2B1B49';
Chart.defaults.plugins.tooltip.borderColor = 'rgba(80,9,181,0.4)';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 12;
Chart.defaults.plugins.tooltip.titleColor = '#FFFFFF';
Chart.defaults.plugins.tooltip.bodyColor = 'rgba(255,255,255,0.8)';
Chart.defaults.plugins.tooltip.cornerRadius = 10;

// ── Color Palette — Carelon brand-safe, color-blind friendly ─
const C = {
  purple: '#5009B5',
  violet: '#794CFF',
  blue:   '#44B8F3',
  teal:   '#00BBBA',
  red:    '#C94A3A',    // salmon-derived — brand-safe, ≥4.5:1 on white
  yellow: '#8B6000',    // dark amber — passes 4.5:1 on white
  green:  '#0F6B4B',    // dark teal-green — passes 4.5:1 on white
  // Array of type colors — brand palette, color-blind safe
  types: ['#5009B5','#794CFF','#44B8F3','#00BBBA','#2B1B49','#1A7AAF','#007F7F','#A37FE0'],
};

// ── Inventory Types ────────────────────────────────────────
const INV_TYPES = [
  'COB SLA 30D',
  'NONCOB SLA 30D',
  'IQT SLA 30D',
  'Cash Control SLA',
  'Collection SLA',
  'Prepay SLA',
  'Dispute Triage SLA',
  'Disputes & Intakes SLA',
];

// ── State ──────────────────────────────────────────────────
const STATE = {
  metricsData:     [],      // Inventory_Metrics rows
  slaData:         [],      // Inventory_SLA rows
  maxRealDate:     '',      // latest date with real data (derived at load)
  latestDataMonth: '',      // 'YYYY-MM' of most recent month containing data
  availableMonths: [],      // ['YYYY-MM', ...] desc — populated after load
  availableYears:  [],      // [YYYY, ...] desc
  dateFilter:      'latest',// active period filter key
  selectedMonths:  [],      // ['YYYY-MM', ...] when filter = 'months'
  selectedYears:   [],      // ['YYYY', ...]    when filter = 'years'
  customStart:     '',      // 'YYYY-MM-DD'     when filter = 'custom'
  customEnd:       '',      // 'YYYY-MM-DD'
  compare:         'none',  // 'none' | 'previous'
  typeFilter:      'all',   // active type filter
  charts:          {},      // chart instances keyed by id
};

// ── Date Filter Engine ─────────────────────────────────────
// Filter keys:
//   'latest'         — full month of the most recent month with actual data
//   'last-complete'  — full calendar month immediately before the latest data month
//   'mtd'            — 1st of current calendar month → today
//   'qtd'            — 1st of current calendar quarter → today
//   'ytd'            — Jan 1 of current year → today
//   'YYYY-MM'        — full specific calendar month (from month selector)
//   'YYYY'           — full specific calendar year   (from year selector)
//   'all'            — full dataset (no date restriction)
//
// "Latest" is the default — it always shows real data, never an empty
// current month at the start of a new period.
//
function getFilterBounds(filter) {
  const now  = new Date();
  const cy   = now.getFullYear();
  const cm   = now.getMonth();   // 0-based
  const cd   = now.getDate();

  let start, end;

  if (filter === 'latest') {
    // Use the most recent month that has actual data.
    // STATE.latestDataMonth is 'YYYY-MM'; fall back to current calendar month.
    const ym = STATE.latestDataMonth || `${cy}-${String(cm + 1).padStart(2,'0')}`;
    const [ly, lm] = ym.split('-').map(Number);
    start = new Date(ly, lm - 1, 1, 0, 0, 0);
    end   = new Date(ly, lm, 0, 23, 59, 59);      // last day of that month

  } else if (filter === 'last-complete') {
    // Month immediately before latestDataMonth
    const ym = STATE.latestDataMonth || `${cy}-${String(cm + 1).padStart(2,'0')}`;
    const [ly, lm] = ym.split('-').map(Number);
    // Go back one month
    const prevDate = new Date(ly, lm - 2, 1);     // lm-2 because lm is 1-based
    const py = prevDate.getFullYear();
    const pm = prevDate.getMonth();                 // 0-based
    start = new Date(py, pm, 1, 0, 0, 0);
    end   = new Date(py, pm + 1, 0, 23, 59, 59);

  } else if (filter === 'cur-month') {
    // Current calendar month (1st → last day)
    start = new Date(cy, cm, 1, 0, 0, 0);
    end   = new Date(cy, cm + 1, 0, 23, 59, 59);

  } else if (filter === 'prev-month') {
    // Previous calendar month (full)
    const pm = cm === 0 ? 11 : cm - 1;
    const py = cm === 0 ? cy - 1 : cy;
    start = new Date(py, pm, 1, 0, 0, 0);
    end   = new Date(py, pm + 1, 0, 23, 59, 59);

  } else if (filter === 'prev-qtr') {
    // Previous calendar quarter (full)
    const curQ  = Math.floor(cm / 3);               // 0–3
    const prevQ = curQ === 0 ? 3 : curQ - 1;
    const qy    = curQ === 0 ? cy - 1 : cy;
    start = new Date(qy, prevQ * 3, 1, 0, 0, 0);
    end   = new Date(qy, prevQ * 3 + 3, 0, 23, 59, 59);

  } else if (filter === 'mtd') {
    start = new Date(cy, cm, 1, 0, 0, 0);
    end   = new Date(cy, cm, cd, 23, 59, 59);

  } else if (filter === 'qtd') {
    const qStartMonth = Math.floor(cm / 3) * 3;
    start = new Date(cy, qStartMonth, 1, 0, 0, 0);
    end   = new Date(cy, cm, cd, 23, 59, 59);

  } else if (filter === 'ytd') {
    start = new Date(cy, 0, 1, 0, 0, 0);
    end   = new Date(cy, cm, cd, 23, 59, 59);

  } else if (/^\d{4}-\d{2}$/.test(filter)) {
    // Specific month: 'YYYY-MM'
    const [fy, fm] = filter.split('-').map(Number);
    start = new Date(fy, fm - 1, 1, 0, 0, 0);
    end   = new Date(fy, fm, 0, 23, 59, 59);

  } else if (/^\d{4}$/.test(filter)) {
    // Specific year: 'YYYY'
    const fy = Number(filter);
    start = new Date(fy, 0, 1, 0, 0, 0);
    end   = new Date(fy, 11, 31, 23, 59, 59);

  } else {
    // 'all' — full dataset
    start = new Date('2000-01-01');
    end   = new Date('2099-12-31');
  }

  return { start, end };
}

function filterByDate(rows, filter, dateKey = 'Date') {
  // Multi-month selection
  if (filter === 'months') {
    const sel = new Set(STATE.selectedMonths);
    return rows.filter(r => r[dateKey] && sel.has(r[dateKey].substring(0, 7)));
  }
  // Multi-year selection
  if (filter === 'years') {
    const sel = new Set(STATE.selectedYears);
    return rows.filter(r => r[dateKey] && sel.has(r[dateKey].substring(0, 4)));
  }
  // Explicit custom range
  if (filter === 'custom') {
    return rows.filter(r =>
      r[dateKey] && r[dateKey] >= STATE.customStart && r[dateKey] <= STATE.customEnd);
  }
  const { start, end } = getFilterBounds(filter);
  return rows.filter(r => {
    if (!r[dateKey]) return false;
    const d = new Date(r[dateKey]);
    return d >= start && d <= end;
  });
}

// Resolve the active filter to concrete start/end Date objects.
// Used for comparison-mode "previous period" calculation.
function getCurrentBounds() {
  const f = STATE.dateFilter;
  if (f === 'months' && STATE.selectedMonths.length) {
    const sorted = [...STATE.selectedMonths].sort();
    const [fy, fm] = sorted[0].split('-').map(Number);
    const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number);
    return { start: new Date(fy, fm - 1, 1), end: new Date(ly, lm, 0, 23, 59, 59) };
  }
  if (f === 'years' && STATE.selectedYears.length) {
    const sorted = [...STATE.selectedYears].sort();
    return { start: new Date(Number(sorted[0]), 0, 1),
             end:   new Date(Number(sorted[sorted.length - 1]), 11, 31, 23, 59, 59) };
  }
  if (f === 'custom' && STATE.customStart && STATE.customEnd) {
    return { start: new Date(STATE.customStart + 'T00:00:00'),
             end:   new Date(STATE.customEnd   + 'T23:59:59') };
  }
  return getFilterBounds(f);
}

// Shift the active period's span back by its own length → previous equivalent period.
function previousPeriodBounds() {
  const { start, end } = getCurrentBounds();
  const spanMs  = end - start;
  const prevEnd = new Date(start.getTime() - 1);            // day before start
  const prevStart = new Date(prevEnd.getTime() - spanMs);   // same length
  return { start: prevStart, end: prevEnd };
}

function filterRowsByBounds(rows, start, end, dateKey = 'Date') {
  return rows.filter(r => {
    if (!r[dateKey]) return false;
    const d = new Date(r[dateKey]);
    return d >= start && d <= end;
  });
}

function fmtDateShort(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Label describing the previous comparison period
function prevPeriodLabel() {
  const { start } = previousPeriodBounds();
  return start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Human-readable label for the active filter (shown in period badge)
function filterLabel(filter) {
  if (filter === 'latest')        return `Latest Available (${fmtMonthKey(STATE.latestDataMonth)})`;
  if (filter === 'last-complete') {
    const ym = STATE.latestDataMonth || '';
    if (!ym) return 'Last Complete Month';
    const [ly, lm] = ym.split('-').map(Number);
    const prev = new Date(ly, lm - 2, 1);
    return `Last Complete Month (${fmtMonthKey(prev.getFullYear()+'-'+String(prev.getMonth()+1).padStart(2,'0'))})`;
  }
  if (filter === 'cur-month') {
    const b = getFilterBounds('cur-month');
    return `Current Month (${fmtMonthKey(b.start.getFullYear()+'-'+String(b.start.getMonth()+1).padStart(2,'0'))})`;
  }
  if (filter === 'prev-month') {
    const b = getFilterBounds('prev-month');
    return `Previous Month (${fmtMonthKey(b.start.getFullYear()+'-'+String(b.start.getMonth()+1).padStart(2,'0'))})`;
  }
  if (filter === 'prev-qtr') {
    const b = getFilterBounds('prev-qtr');
    const q = Math.floor(b.start.getMonth() / 3) + 1;
    return `Previous Quarter (Q${q} ${b.start.getFullYear()})`;
  }
  if (filter === 'mtd')  return 'Month to Date';
  if (filter === 'qtd') {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    return `Current Quarter (Q${q} ${now.getFullYear()} to date)`;
  }
  if (filter === 'ytd')  return `Current Year (${new Date().getFullYear()} to date)`;
  if (filter === 'all')  return 'All Data';
  if (filter === 'months') {
    const n = STATE.selectedMonths.length;
    if (n === 1) return fmtMonthKey(STATE.selectedMonths[0]);
    return `${n} Months Selected`;
  }
  if (filter === 'years') {
    const n = STATE.selectedYears.length;
    if (n === 1) return `Full Year ${STATE.selectedYears[0]}`;
    return `${n} Years Selected`;
  }
  if (filter === 'custom') {
    const s = fmtDateShort(new Date(STATE.customStart + 'T00:00:00'));
    const e = fmtDateShort(new Date(STATE.customEnd   + 'T00:00:00'));
    return `Custom: ${s} – ${e}`;
  }
  if (/^\d{4}-\d{2}$/.test(filter)) return fmtMonthKey(filter);
  if (/^\d{4}$/.test(filter))       return `Full Year ${filter}`;
  return filter;
}

function fmtMonthKey(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

// Populate month + year multi-select pickers once data is loaded
function populateFilterSelects() {
  const monthHTML = STATE.availableMonths.map(ym =>
    `<label class="ms-item"><input type="checkbox" value="${ym}"><span>${fmtMonthKey(ym)}</span></label>`
  ).join('');
  const yearHTML = STATE.availableYears.map(y =>
    `<label class="ms-item"><input type="checkbox" value="${y}"><span>${y}</span></label>`
  ).join('');
  document.querySelectorAll('.ms-month-menu').forEach(m => { m.innerHTML = monthHTML; });
  document.querySelectorAll('.ms-year-menu').forEach(m => { m.innerHTML = yearHTML; });
}

// Update the visible label on every multi-picker button
function syncPickerLabels() {
  const mCount = STATE.selectedMonths.length;
  const yCount = STATE.selectedYears.length;
  const mLabel = mCount === 0 ? 'Select Months ▾'
               : mCount === 1 ? fmtMonthKey(STATE.selectedMonths[0]) + ' ▾'
               : `${mCount} Months ▾`;
  const yLabel = yCount === 0 ? 'Select Years ▾'
               : yCount === 1 ? STATE.selectedYears[0] + ' ▾'
               : `${yCount} Years ▾`;
  document.querySelectorAll('.ms-month-btn').forEach(b => { b.textContent = mLabel; });
  document.querySelectorAll('.ms-year-btn').forEach(b => { b.textContent = yLabel; });
}

// Sync checkbox states across all pages' pickers
function syncPickerChecks() {
  const mSet = new Set(STATE.selectedMonths);
  const ySet = new Set(STATE.selectedYears);
  document.querySelectorAll('.ms-month-menu input').forEach(i => { i.checked = mSet.has(i.value); });
  document.querySelectorAll('.ms-year-menu input').forEach(i => { i.checked = ySet.has(i.value); });
}

// Show/hide the no-data empty state for a page container
function showEmptyState(containerId, message) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-title">No Data Available</div>
      <div class="empty-state-msg">${message}</div>
      <div class="empty-state-hint">Try selecting <strong>Latest Month</strong> or a different period.</div>
    </div>`;
}

// Set the active filter, sync every control, then render the page
function applyFilter(filter, pageRenderFn) {
  STATE.dateFilter = filter;

  // Update period badge on all pages
  const lbl = filterLabel(filter);
  document.querySelectorAll('.period-badge').forEach(el => { el.textContent = lbl; });

  // Highlight matching pill (months/years/custom have no pill → all off)
  document.querySelectorAll('.btn-period').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === filter);
  });

  // Single-month / single-year filter values auto-populate the pickers
  if (/^\d{4}-\d{2}$/.test(filter)) {
    STATE.dateFilter = 'months';
    STATE.selectedMonths = [filter];
    STATE.selectedYears  = [];
  } else if (/^\d{4}$/.test(filter)) {
    STATE.dateFilter = 'years';
    STATE.selectedYears  = [filter];
    STATE.selectedMonths = [];
  } else if (filter === 'months') {
    STATE.selectedYears = [];
  } else if (filter === 'years') {
    STATE.selectedMonths = [];
  } else {
    STATE.selectedMonths = [];
    STATE.selectedYears  = [];
  }

  // Clear custom date inputs unless custom is active
  if (STATE.dateFilter !== 'custom') {
    document.querySelectorAll('.filter-custom-from, .filter-custom-to')
      .forEach(i => { i.value = ''; });
  }

  syncPickerChecks();
  syncPickerLabels();
  pageRenderFn();
}

// ── Number Formatting ──────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtFull(n) {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString();
}
function pct(n) {
  if (!n && n !== 0) return '—';
  return (n * 100).toFixed(1) + '%';
}

// ── Chart Helpers ──────────────────────────────────────────
function destroyChart(id) {
  if (STATE.charts[id]) { STATE.charts[id].destroy(); delete STATE.charts[id]; }
}
function makeChart(id, config) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return null;
  const chart = new Chart(ctx, config);
  STATE.charts[id] = chart;
  return chart;
}

function gridOpts(yLabel = '', formatCb = null) {
  return {
    scales: {
      x: {
        type: 'time',
        time: { unit: 'day', tooltipFormat: 'MMM d, yyyy', displayFormats: { day: 'MMM d' } },
        grid: { color: 'rgba(80,9,181,0.07)' },
        ticks: { maxTicksLimit: 8, color: '#7B74A0' },
      },
      y: {
        grid: { color: 'rgba(80,9,181,0.07)' },
        ticks: {
          color: '#7B74A0',
          callback: formatCb || (v => fmt(v)),
        },
        title: yLabel ? { display: true, text: yLabel, color: '#7B74A0', font: { size: 11 } } : { display: false },
      },
    },
  };
}

function barGridOpts() {
  return {
    scales: {
      x: {
        grid: { color: 'rgba(80,9,181,0.07)' },
        ticks: { color: '#7B74A0' },
      },
      y: {
        grid: { color: 'rgba(80,9,181,0.07)' },
        ticks: { color: '#7B74A0', callback: v => fmt(v) },
      },
    },
  };
}

function tooltipTitle(items) {
  const raw = items[0]?.raw;
  if (raw && raw.x) {
    const d = new Date(raw.x);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return items[0]?.label || '';
}

// ── Storytelling Helpers ───────────────────────────────────
// Returns indices of peak, low, and last non-null point in a pts array.
function storyPoints(pts) {
  let peakIdx = -1, lowIdx = -1, lastIdx = -1;
  pts.forEach((p, i) => {
    if (p.y == null) return;
    lastIdx = i;
    if (peakIdx === -1 || p.y > pts[peakIdx].y) peakIdx = i;
    if (lowIdx  === -1 || p.y < pts[lowIdx].y)  lowIdx  = i;
  });
  return { peakIdx, lowIdx, lastIdx };
}

// Datalabels config for a time-series line: show callout labels only at
// peak / low / last points. labelIdx is a Set of indices to show.
function timelineCalloutDL(pts, fmtFn, labelMap, color) {
  // labelMap: { idx -> 'Peak'|'Low'|'Current' }
  const showSet = new Set(Object.keys(labelMap).map(Number));
  return {
    display: ctx => showSet.has(ctx.dataIndex) && pts[ctx.dataIndex]?.y != null,
    backgroundColor: '#fff',
    borderColor: color,
    borderWidth: 1.5,
    borderRadius: 6,
    padding: { top: 4, bottom: 4, left: 7, right: 7 },
    color: '#231E33',
    font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
    formatter: (val, ctx) => {
      const tag = labelMap[ctx.dataIndex] || '';
      const v   = fmtFn(typeof val === 'object' ? val.y : val);
      return tag ? `${tag}\n${v}` : v;
    },
    anchor: ctx => {
      const idx = ctx.dataIndex;
      const tag = labelMap[idx];
      return tag === 'Low' ? 'start' : 'end';
    },
    align: ctx => {
      const tag = labelMap[ctx.dataIndex];
      return tag === 'Low' ? 'bottom' : 'top';
    },
    offset: 6,
    clamp: true,
  };
}

// Simple above-bar datalabels for category bar charts
function barDL(fmtFn, color = '#231E33') {
  return {
    display: true,
    anchor: 'end',
    align: 'end',
    offset: 3,
    color,
    font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
    formatter: v => fmtFn(v),
    clamp: true,
  };
}

// Callout-style datalabels for time-based bar charts (peak/low/current)
function buildProdBarDL(pts, sp) {
  const labelMap = {};
  if (sp.peakIdx >= 0) labelMap[sp.peakIdx] = 'Peak';
  if (sp.lowIdx  >= 0) labelMap[sp.lowIdx]  = 'Low';
  if (sp.lastIdx >= 0) labelMap[sp.lastIdx] = 'Current';
  const showSet = new Set(Object.keys(labelMap).map(Number));
  return {
    display: ctx => showSet.has(ctx.dataIndex) && pts[ctx.dataIndex]?.y != null,
    backgroundColor: '#fff',
    borderColor: C.blue,
    borderWidth: 1.5,
    borderRadius: 6,
    padding: { top: 4, bottom: 4, left: 7, right: 7 },
    color: '#231E33',
    font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
    formatter: (val, ctx) => {
      const tag = labelMap[ctx.dataIndex] || '';
      const v = fmt(typeof val === 'object' ? val.y : val);
      return tag ? `${tag}\n${v}` : v;
    },
    anchor: ctx => labelMap[ctx.dataIndex] === 'Low' ? 'start' : 'end',
    align: ctx => labelMap[ctx.dataIndex] === 'Low' ? 'bottom' : 'top',
    offset: 6,
    clamp: true,
  };
}

// ── Aggregate helpers ──────────────────────────────────────
function sumByDateMetric(rows, metric, typeFilter = 'all') {
  const map = {};
  rows.forEach(r => {
    if (!r.Date || !r.Metric || !r.Value) return;
    if (r.Metric !== metric) return;
    if (typeFilter !== 'all' && r.InventoryType !== typeFilter) return;
    map[r.Date] = (map[r.Date] || 0) + r.Value;
  });
  return Object.entries(map).sort((a,b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ x: d, y: v }));
}

function sumByType(rows, metric, typeFilter = 'all') {
  const map = {};
  INV_TYPES.forEach(t => map[t] = 0);
  rows.forEach(r => {
    if (!r.Metric || r.Metric !== metric) return;
    if (typeFilter !== 'all' && r.InventoryType !== typeFilter) return;
    if (map[r.InventoryType] !== undefined) map[r.InventoryType] += (r.Value || 0);
  });
  return INV_TYPES.map(t => ({ type: t, value: map[t] }));
}

function movingAverage(pts, window) {
  return pts.map((p, i) => {
    if (i < window - 1) return { x: p.x, y: null };
    const slice = pts.slice(i - window + 1, i + 1);
    const avg = slice.reduce((s, q) => s + q.y, 0) / window;
    return { x: p.x, y: avg };
  });
}

// ── Main Data Load ─────────────────────────────────────────
// Data is embedded via data.js (window.CATALYST_DATA) — no fetch/server needed.
// This means the dashboard opens directly from File Explorer (file:// protocol).
async function loadData() {
  setLoadProgress(10);

  // Validate embedded data is present (data.js must be loaded before app.js)
  if (!window.CATALYST_DATA) {
    throw new Error('window.CATALYST_DATA not found — ensure data.js is loaded before app.js');
  }

  setLoadProgress(50);
  STATE.metricsData = window.CATALYST_DATA.metrics;
  STATE.slaData     = window.CATALYST_DATA.sla;
  setLoadProgress(80);

  // Clean: remove rows with empty/null dates and future zero-padded rows
  STATE.metricsData = STATE.metricsData.filter(r => r.Date && r.Date !== '');
  STATE.slaData     = STATE.slaData.filter(r => r.Date && r.Date !== '');

  // Derive latest date containing real data — used to exclude
  // future-dated zero-placeholder rows without a hardcoded cutoff.
  const maxMetricDate = STATE.metricsData
    .filter(r => r.Value > 0)
    .reduce((m, r) => (r.Date > m ? r.Date : m), '0000-00-00');
  const maxSlaDate = STATE.slaData
    .reduce((m, r) => (r.Date > m ? r.Date : m), '0000-00-00');
  STATE.maxRealDate = maxMetricDate > maxSlaDate ? maxMetricDate : maxSlaDate;
  if (STATE.maxRealDate === '0000-00-00') STATE.maxRealDate = '2099-12-31';

  // ── Derive available months and years from real metric data ───
  // Only include months that have at least one row with Value > 0.
  const monthSet = new Set();
  const yearSet  = new Set();
  STATE.metricsData.filter(r => r.Value > 0 && r.Date).forEach(r => {
    const ym = r.Date.substring(0, 7);   // 'YYYY-MM'
    monthSet.add(ym);
    yearSet.add(r.Date.substring(0, 4)); // 'YYYY'
  });
  STATE.availableMonths = [...monthSet].sort((a,b) => b.localeCompare(a));  // desc
  STATE.availableYears  = [...yearSet].sort((a,b)  => b.localeCompare(a));  // desc

  // Latest data month = first element of sorted-desc list
  STATE.latestDataMonth = STATE.availableMonths[0] || '';

  // Populate the month and year <select> dropdowns
  populateFilterSelects();

  // Set last refresh timestamp
  const lastDate = STATE.slaData.slice().sort((a,b)=>b.Date.localeCompare(a.Date))[0]?.Date || 'Unknown';
  document.getElementById('lastRefresh').textContent = lastDate;

  setLoadProgress(100);
  await new Promise(r => setTimeout(r, 400));
  hideLoading();
  renderAll();
}

function setLoadProgress(pct) {
  const bar = document.getElementById('loadingBarFill');
  if (bar) bar.style.width = pct + '%';
}

function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.classList.add('hidden');
}

// ── Master Render ──────────────────────────────────────────
function renderAll() {
  renderOverview();
  renderInventoryPage();
  renderSLAPage();
  renderProductionPage();
  renderTrendsPage();
  renderValidationPage();
}

// ── Filter matching helper ─────────────────────────────────
function getFilteredMetrics(dateFilter, typeFilter) {
  let rows = filterByDate(STATE.metricsData, dateFilter);
  // Remove future-dated zero rows (after latest real data date)
  rows = rows.filter(r => r.Date <= STATE.maxRealDate);
  if (typeFilter && typeFilter !== 'all') {
    rows = rows.filter(r => r.InventoryType === typeFilter);
  }
  return rows;
}

function getFilteredSLA(dateFilter) {
  let rows = filterByDate(STATE.slaData, dateFilter);
  rows = rows.filter(r => r.Date <= STATE.maxRealDate);
  return rows;
}

// ── PAGE 1: Executive Overview ─────────────────────────────
function renderOverview() {
  const df = STATE.dateFilter;
  const tf = STATE.typeFilter;
  const rows    = getFilteredMetrics(df, tf);
  const slaRows = getFilteredSLA(df);

  // ── No-data guard ─────────────────────────────────────────
  // If neither metrics nor SLA rows exist for the period, show
  // a clear empty state rather than a dashboard full of zeroes.
  if (!rows.length && !slaRows.length) {
    const lbl = filterLabel(df);
    // Reset all KPIs to em-dash so nothing looks like real data
    ['val-total','val-inSLA','val-outSLA','val-daily','val-entSLA',
     'donut-pct','legend-met','legend-missed','trend-total','trend-inSLA',
     'trend-outSLA','trend-daily','trend-entSLA'].forEach(id => setEl(id, '—'));
    // Clear charts gracefully
    ['donutChart','treemapChart','invTrendChart','slaTrendChart','prodTrendChart']
      .forEach(id => destroyChart(id));
    // Show empty state message in the main visual area
    const riskBody = document.getElementById('riskTableBody');
    if (riskBody) riskBody.innerHTML =
      `<tr><td colspan="5" class="empty-state-row">No data for ${lbl} — try Latest Month or All Data.</td></tr>`;
    // Remove pass/fail styling
    const entCard = document.getElementById('kpi-entSLA');
    if (entCard) { entCard.classList.remove('sla-passing','sla-failing'); }
    return;
  }

  // KPIs
  const total = rows.filter(r=>r.Metric==='Total').reduce((s,r)=>s+r.Value,0);
  const inSLA  = rows.filter(r=>r.Metric==='IN SLA').reduce((s,r)=>s+r.Value,0);
  const outSLA = rows.filter(r=>r.Metric==='Out of SLA').reduce((s,r)=>s+r.Value,0);
  const daily  = rows.filter(r=>r.Metric==='Daily Production').reduce((s,r)=>s+r.Value,0);
  const entSLAPct = slaRows.length ? slaRows.reduce((s,r)=>s+r.SLA_Pct,0)/slaRows.length : 0;

  setEl('val-total',   fmt(total));
  setEl('val-inSLA',   fmt(inSLA));
  setEl('val-outSLA',  fmt(outSLA));
  setEl('val-daily',   fmt(daily));
  setEl('val-entSLA',  (entSLAPct*100).toFixed(1)+'%');

  // ── Comparison mode: deltas vs previous equivalent period ──
  const trendIds = ['trend-total','trend-outSLA','trend-inSLA','trend-daily','trend-entSLA'];
  if (STATE.compare === 'previous' && df !== 'all') {
    const prev     = previousPeriodBounds();
    const prevLbl  = prevPeriodLabel();
    const prevRows    = filterRowsByBounds(STATE.metricsData, prev.start, prev.end)
                          .filter(r => r.Date <= STATE.maxRealDate
                                    && (!tf || tf === 'all' || r.InventoryType === tf));
    const prevSlaRows = filterRowsByBounds(STATE.slaData, prev.start, prev.end)
                          .filter(r => r.Date <= STATE.maxRealDate);

    const pTotal = prevRows.filter(r=>r.Metric==='Total').reduce((s,r)=>s+r.Value,0);
    const pIn    = prevRows.filter(r=>r.Metric==='IN SLA').reduce((s,r)=>s+r.Value,0);
    const pOut   = prevRows.filter(r=>r.Metric==='Out of SLA').reduce((s,r)=>s+r.Value,0);
    const pDaily = prevRows.filter(r=>r.Metric==='Daily Production').reduce((s,r)=>s+r.Value,0);
    const pEnt   = prevSlaRows.length
                   ? prevSlaRows.reduce((s,r)=>s+r.SLA_Pct,0)/prevSlaRows.length
                   : 0;

    const setDelta = (id, cur, prv, favorableUp, isPct=false) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!prv) { el.textContent = `— vs ${prevLbl}`; el.className = 'kpi-trend'; return; }
      const delta  = cur - prv;
      const deltaP = prv !== 0 ? (delta / prv) * 100 : 0;
      const arrow  = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
      const txt    = isPct
        ? `${arrow} ${(delta*100>=0?'+':'')}${(delta*100).toFixed(1)}pp vs ${prevLbl}`
        : `${arrow} ${(deltaP>=0?'+':'')}${deltaP.toFixed(1)}% vs ${prevLbl}`;
      el.textContent = txt;
      el.className   = 'kpi-trend ' +
        (delta === 0 ? '' : (delta > 0) === favorableUp ? 'up' : 'down');
    };

    setDelta('trend-total',  total,     pTotal, true);
    setDelta('trend-outSLA', outSLA,    pOut,   false);   // higher Out of SLA is worse
    setDelta('trend-inSLA',  inSLA,     pIn,    true);
    setDelta('trend-daily',  daily,     pDaily, true);
    setDelta('trend-entSLA', entSLAPct, pEnt,   true, true);
  } else {
    trendIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; el.className = 'kpi-trend'; }
    });
  }

  // Enterprise SLA pass/fail (threshold: 90%)
  const SLA_THRESHOLD = 0.90;
  const slaPassing = entSLAPct >= SLA_THRESHOLD;
  const entCard = document.getElementById('kpi-entSLA');
  if (entCard) {
    entCard.classList.toggle('sla-passing', slaPassing);
    entCard.classList.toggle('sla-failing', !slaPassing);
  }
  // SLA status badge on the SLA Health panel
  const slaBadge = document.getElementById('sla-badge');
  if (slaBadge) {
    slaBadge.textContent = slaPassing ? 'PASSING SLA' : 'FAILING SLA';
    slaBadge.className   = slaPassing ? 'sla-badge sla-badge-pass' : 'sla-badge sla-badge-fail';
  }

  // SLA health donut
  const slaHealthPct = total > 0 ? inSLA / total : 0;
  setEl('donut-pct', (slaHealthPct*100).toFixed(1)+'%');
  setEl('legend-met',    fmtFull(inSLA));
  setEl('legend-missed', fmtFull(outSLA));
  renderDonut(inSLA, outSLA);

  // Treemap & Risk table
  renderTreemap(rows);
  renderRiskTable(rows);

  // Trend charts with peak/low/current callouts
  const invTrend  = sumByDateMetric(getFilteredMetrics(df,'all'), 'Total', tf);
  const slaTrend  = getFilteredSLA(df).map(r=>({x:r.Date, y:r.SLA_Pct*100})).sort((a,b)=>a.x.localeCompare(b.x));
  const prodTrend = sumByDateMetric(getFilteredMetrics(df,'all'), 'Daily Production', tf);

  const invSP  = storyPoints(invTrend);
  const slaSP  = storyPoints(slaTrend);
  const prodSP = storyPoints(prodTrend);

  // Build labelMaps — collapse duplicates (e.g. peak === last)
  function buildLabelMap(sp) {
    const m = {};
    if (sp.peakIdx >= 0) m[sp.peakIdx]  = 'Peak';
    if (sp.lowIdx  >= 0) m[sp.lowIdx]   = 'Low';
    if (sp.lastIdx >= 0) m[sp.lastIdx]  = 'Current';  // may overwrite Peak
    return m;
  }

  renderLineChart('invTrendChart', invTrend, C.violet, v=>fmt(v),
    timelineCalloutDL(invTrend, v=>fmt(v), buildLabelMap(invSP), C.violet));
  renderLineChart('slaTrendChart', slaTrend, C.teal, v=>v.toFixed(1)+'%',
    timelineCalloutDL(slaTrend, v=>v.toFixed(1)+'%', buildLabelMap(slaSP), C.teal));
  renderBarChart('prodTrendChart', prodTrend, C.blue,
    buildProdBarDL(prodTrend, prodSP));
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Donut Chart ────────────────────────────────────────────
function renderDonut(inSLA, outSLA) {
  makeChart('donutChart', {
    type: 'doughnut',
    data: {
      labels: ['In SLA','Out of SLA'],
      datasets: [{
        data: [inSLA, outSLA],
        backgroundColor: [C.teal, '#FA8072'],
        borderColor: 'transparent',
        borderWidth: 0,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
              const p = total>0 ? ((ctx.parsed/total)*100).toFixed(1) : 0;
              return ` ${ctx.label}: ${fmtFull(ctx.parsed)} (${p}%)`;
            },
          },
        },
      },
    },
  });
}

// ── Treemap ────────────────────────────────────────────────
function renderTreemap(rows) {
  const byType = sumByType(rows, 'Total').filter(t=>t.value>0);
  if (!byType.length) { destroyChart('treemapChart'); return; }

  // chartjs-chart-treemap v2.x: flat data format with 'key' pointing to numeric field
  const treeData = byType.map((t, i) => ({
    label: t.type,
    value: t.value,
    colorIdx: i,
  }));

  makeChart('treemapChart', {
    type: 'treemap',
    data: {
      datasets: [{
        label: 'Inventory by Type',
        tree: treeData,
        key: 'value',
        backgroundColor(ctx) {
          if (ctx.type !== 'data') return 'transparent';
          const idx = ctx.raw?._data?.colorIdx ?? 0;
          return C.types[idx % C.types.length] + 'CC';
        },
        borderColor: 'rgba(0,0,0,0.4)',
        borderWidth: 2,
        labels: {
          display: true,
          align: 'center',
          position: 'middle',
          color: '#fff',
          font: [
            { size: 12, weight: 'bold' },
            { size: 11 },
          ],
          formatter(ctx) {
            const lbl = ctx.raw?._data?.label || '';
            const val = ctx.raw?.v || 0;
            return [
              lbl.replace(' SLA','').replace(' 30D',''),
              fmt(val),
            ];
          },
        },
        spacing: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: () => '',
            label(ctx) {
              const lbl = ctx.raw?._data?.label || ctx.raw?.label || '';
              const val = ctx.raw?.v ?? ctx.raw?.value ?? 0;
              return ` ${lbl}: ${fmtFull(val)}`;
            },
          },
        },
      },
    },
  });
}

// ── Risk Table ─────────────────────────────────────────────
function renderRiskTable(rows) {
  const tbody = document.getElementById('riskTableBody');
  if (!tbody) return;
  const totals   = sumByType(rows, 'Total');
  const outSLAs  = sumByType(rows, 'Out of SLA');

  const combined = INV_TYPES.map((t,i) => ({
    type: t,
    total: totals[i].value,
    outSLA: outSLAs[i].value,
    pct: totals[i].value > 0 ? outSLAs[i].value / totals[i].value : 0,
  })).sort((a,b)=>b.pct-a.pct);

  tbody.innerHTML = combined.map(row => {
    const outPct = (row.pct * 100).toFixed(1);
    const inPct  = (100 - row.pct * 100).toFixed(1);
    // Out SLA %: low ≤2% green, medium ≤5% yellow, high >5% salmon
    let outBadgeCls = 'risk-badge-green';
    if (row.pct > 0.05)      { outBadgeCls = 'risk-badge-red'; }
    else if (row.pct > 0.02) { outBadgeCls = 'risk-badge-yellow'; }
    // In SLA %: >= 90% green, < 90% salmon — identical badge component
    const inBadgeCls = parseFloat(inPct) >= 90 ? 'risk-badge-green' : 'risk-badge-red';
    return `
      <tr>
        <td>${row.type}</td>
        <td>${fmtFull(row.total)}</td>
        <td>${fmtFull(row.outSLA)}</td>
        <td><span class="risk-badge ${outBadgeCls}">${outPct}%</span></td>
        <td><span class="risk-badge ${inBadgeCls}">${inPct}%</span></td>
      </tr>`;
  }).join('');
}

// ── Generic Line Chart ─────────────────────────────────────
// calloutCfg: optional datalabels config object for this dataset
function renderLineChart(id, pts, color, tickFmt, calloutCfg = null) {
  const grad = (ctx) => {
    const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
    g.addColorStop(0, color + '50');
    g.addColorStop(1, color + '00');
    return g;
  };

  // Determine pointRadius: show a dot only at callout indices
  const calloutIdxs = calloutCfg
    ? new Set(Object.keys(calloutCfg.formatter?._labelMap || {}).map(Number))
    : new Set();

  makeChart(id, {
    type: 'line',
    data: {
      datasets: [{
        data: pts,
        borderColor: color,
        borderWidth: 2,
        fill: true,
        backgroundColor: grad,
        tension: 0.4,
        pointRadius: pts.length > 60 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: color,
        datalabels: calloutCfg || { display: false },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Reserved annotation space: Peak labels render above (top),
      // Low labels render below (bottom), Current sits near right edge.
      layout: { padding: { top: 56, bottom: 44, left: 8, right: 76 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: tooltipTitle,
            label: ctx => ` ${ctx.dataset.label || 'Value'}: ${tickFmt ? tickFmt(ctx.parsed.y) : fmt(ctx.parsed.y)}`,
          },
        },
      },
      ...gridOpts('', tickFmt),
    },
  });
}

// ── Generic Bar Chart ──────────────────────────────────────
// calloutCfg: optional datalabels config for bar labels
function renderBarChart(id, pts, color, calloutCfg = null) {
  makeChart(id, {
    type: 'bar',
    data: {
      datasets: [{
        data: pts,
        backgroundColor: color + '99',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 4,
        hoverBackgroundColor: color,
        datalabels: calloutCfg || { display: false },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Reserved annotation space so Peak/Low/Current badges never clip
      layout: { padding: { top: 56, bottom: 44, left: 8, right: 76 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: tooltipTitle,
            label: ctx => ` Production: ${fmt(ctx.parsed.y)}`,
          },
        },
      },
      ...gridOpts(),
    },
  });
}

// ── PAGE 2: Inventory Analytics ────────────────────────────
function renderInventoryPage() {
  const df = STATE.dateFilter;
  const rows = getFilteredMetrics(df, 'all');

  // Stacked bar by type
  const totals = sumByType(rows, 'Total');
  const labels = INV_TYPES.map(t=>t.replace(' SLA','').replace(' 30D',''));
  const totalVals = totals.map(t=>t.value);

  makeChart('invByTypeChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Inventory',
        data: totalVals,
        backgroundColor: C.types.map(c => c+'BB'),
        borderColor: C.types,
        borderWidth: 1,
        borderRadius: 6,
        datalabels: barDL(v => fmt(v)),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx=>`${ctx.label}: ${fmtFull(ctx.parsed.y)}` } },
      },
      ...barGridOpts(),
    },
  });

  // In SLA vs Out of SLA by type (grouped bar) — labels on each bar
  const inSLAs = sumByType(rows, 'IN SLA');
  const outSLAs= sumByType(rows, 'Out of SLA');
  const groupBarDL = {
    display: true,
    anchor: 'end',
    align: 'end',
    offset: 2,
    color: '#231E33',
    font: { size: 10, weight: '700', family: "'Segoe UI', sans-serif" },
    formatter: v => fmt(v),
    clamp: true,
  };
  makeChart('slaCompareChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'In SLA',     data: inSLAs.map(t=>t.value),  backgroundColor: C.teal+'AA',  borderColor: C.teal,   borderWidth:1, borderRadius:4, datalabels: groupBarDL },
        { label: 'Out of SLA', data: outSLAs.map(t=>t.value), backgroundColor: '#FA807288', borderColor: '#FA8072', borderWidth:1, borderRadius:4, datalabels: groupBarDL },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: { legend: { display: true, labels: { color: '#4A4560', boxWidth: 12, padding: 16 } },
        tooltip: { callbacks: { label: ctx=>`${ctx.dataset.label}: ${fmtFull(ctx.parsed.y)}` } },
      },
      ...barGridOpts(),
    },
  });

  // Pie distribution — external labels with leader lines, no internal crowding
  const total = totalVals.reduce((s,v)=>s+v,0);
  makeChart('invPieChart', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: totalVals,
        backgroundColor: C.types.map(c=>c+'DD'),
        borderColor: '#fff',
        borderWidth: 3,
        hoverOffset: 10,
        datalabels: {
          // Only label slices that are >= 3% — tiny slivers get tooltip only
          display: ctx => {
            const v = ctx.dataset.data[ctx.dataIndex];
            return total > 0 && (v / total) >= 0.03;
          },
          // Place label outside the arc
          anchor: 'end',
          align: 'end',
          offset: 14,
          padding: { top: 3, bottom: 3, left: 6, right: 6 },
          // White pill background with slice-colour border
          backgroundColor: '#fff',
          borderColor: ctx => C.types[ctx.dataIndex % C.types.length],
          borderWidth: 1.5,
          borderRadius: 5,
          color: '#231E33',
          font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
          formatter: (v, ctx) => {
            const p   = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '';
            const lbl = (ctx.chart.data.labels[ctx.dataIndex] || '')
                          .replace(' SLA', '').replace(' 30D', '');
            return `${lbl}\n${p}  ${fmt(v)}`;
          },
          // Draw a thin leader line from label to slice edge
          listeners: {},
          clip: false,
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      // Extra padding so external labels aren't clipped
      layout: { padding: { top: 44, bottom: 44, left: 96, right: 96 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.label}: ${fmt(ctx.parsed)} (${total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) + '%' : '—'})`,
          },
        },
      },
    },
  });
}

// ── PAGE 3: SLA Analytics ──────────────────────────────────
function renderSLAPage() {
  const df = STATE.dateFilter;
  const slaRows = getFilteredSLA(df);
  const metRows = getFilteredMetrics(df, 'all');

  // KPIs
  const avg = slaRows.length ? slaRows.reduce((s,r)=>s+r.SLA_Pct,0)/slaRows.length : 0;
  setEl('sla-avg', (avg*100).toFixed(1)+'%');

  const sorted = [...slaRows].sort((a,b)=>b.SLA_Pct-a.SLA_Pct);
  if (sorted.length) {
    setEl('sla-peak', `${(sorted[0].SLA_Pct*100).toFixed(1)}% on ${sorted[0].Date}`);
    setEl('sla-low',  `${(sorted[sorted.length-1].SLA_Pct*100).toFixed(1)}% on ${sorted[sorted.length-1].Date}`);
  }

  // Full SLA trend — with peak / low / current callouts
  const slaPts = slaRows.map(r=>({x:r.Date,y:r.SLA_Pct*100})).sort((a,b)=>a.x.localeCompare(b.x));
  const slaSPFull = storyPoints(slaPts);
  const slaLabelMap = {};
  if (slaSPFull.peakIdx >= 0) slaLabelMap[slaSPFull.peakIdx] = 'High';
  if (slaSPFull.lowIdx  >= 0) slaLabelMap[slaSPFull.lowIdx]  = 'Low';
  if (slaSPFull.lastIdx >= 0) slaLabelMap[slaSPFull.lastIdx] = 'Current';
  renderLineChart('slaTrendChartFull', slaPts, C.teal, v=>v.toFixed(1)+'%',
    timelineCalloutDL(slaPts, v=>v.toFixed(1)+'%', slaLabelMap, C.teal));

  // SLA % by type bar
  const totals = sumByType(metRows,'Total');
  const inSLAs = sumByType(metRows,'IN SLA');
  const slaByType = INV_TYPES.map((t,i)=>({
    type: t.replace(' SLA','').replace(' 30D',''),
    pct: totals[i].value > 0 ? inSLAs[i].value/totals[i].value*100 : 0,
  }));

  // SLA % by type — bar with value labels and 90% threshold visual
  const slaDL = {
    display: true,
    anchor: 'end',
    align: 'end',
    offset: 3,
    color: '#231E33',
    font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
    formatter: v => v.toFixed(1)+'%',
    clamp: true,
  };
  makeChart('slaByTypeChart', {
    type: 'bar',
    data: {
      labels: slaByType.map(t=>t.type),
      datasets: [{
        data: slaByType.map(t=>t.pct),
        backgroundColor: slaByType.map(t => t.pct >= 90 ? C.teal+'AA' : '#FA807288'),
        borderColor:     slaByType.map(t => t.pct >= 90 ? C.teal      : '#FA8072'),
        borderWidth: 1,
        borderRadius: 6,
        datalabels: slaDL,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: {
        tooltip: { callbacks: { label: ctx=>`SLA%: ${ctx.parsed.y.toFixed(1)}%` } },
      },
      scales: {
        x: { grid:{color:'rgba(80,9,181,0.07)'}, ticks:{color:'#7B74A0'} },
        y: { grid:{color:'rgba(80,9,181,0.07)'}, min:0, max:100,
             ticks:{color:'#7B74A0', callback:v=>v+'%'} },
      },
    },
  });

  // SLA histogram (distribution buckets) — count labels on bars
  const buckets = [0,10,20,30,40,50,60,70,80,90,100];
  const counts = new Array(buckets.length-1).fill(0);
  slaRows.forEach(r=>{
    const p = r.SLA_Pct*100;
    for (let i=0;i<counts.length;i++) {
      if (p >= buckets[i] && p < buckets[i+1]) { counts[i]++; break; }
    }
  });
  const histLabels = counts.map((_,i)=>`${buckets[i]}-${buckets[i+1]}%`);
  makeChart('slaHistChart', {
    type: 'bar',
    data: {
      labels: histLabels,
      datasets: [{
        label: 'Days',
        data: counts,
        backgroundColor: counts.map((_,i)=> i<5 ? C.red+'88' : i<8 ? C.yellow+'88' : C.teal+'88'),
        borderColor:     counts.map((_,i)=> i<5 ? C.red      : i<8 ? C.yellow      : C.teal),
        borderWidth: 1,
        borderRadius: 4,
        datalabels: {
          display: ctx => ctx.dataset.data[ctx.dataIndex] > 0,
          anchor: 'end',
          align: 'end',
          offset: 3,
          color: '#231E33',
          font: { size: 11, weight: '700', family: "'Segoe UI', sans-serif" },
          formatter: v => v + (v === 1 ? ' day' : ' days'),
          clamp: true,
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx=>`Days: ${ctx.parsed.y}` } },
      },
      scales: {
        x: { grid:{color:'rgba(80,9,181,0.07)'}, ticks:{color:'#7B74A0', font:{size:10}} },
        y: { grid:{color:'rgba(80,9,181,0.07)'}, ticks:{color:'#7B74A0'} },
      },
    },
  });
}

// ── PAGE 4: Production Analytics ───────────────────────────
function renderProductionPage() {
  const df = STATE.dateFilter;
  const tf = document.getElementById('prodTypeFilter')?.value || 'all';
  const rows = getFilteredMetrics(df, tf);

  const dailyPts = sumByDateMetric(rows, 'Daily Production');
  const totalProd = dailyPts.reduce((s,p)=>s+p.y,0);
  const nonZero = dailyPts.filter(p=>p.y>0);
  const peakDay = nonZero.reduce((m,p)=>p.y>m.y?p:m, {y:0,x:''});
  const avgProd = nonZero.length ? totalProd/nonZero.length : 0;

  setEl('prod-total', fmt(totalProd));
  setEl('prod-peak',  peakDay.x ? `${fmt(peakDay.y)} on ${peakDay.x}` : fmt(peakDay.y));
  setEl('prod-avg',   fmt(avgProd));

  // Full production trend — peak / low / current callouts
  const dailySP = storyPoints(dailyPts);
  renderBarChart('prodTrendChartFull', dailyPts, C.blue,
    buildProdBarDL(dailyPts, dailySP));

  // Production by type — value labels above bars
  const byType = sumByType(rows, 'Daily Production').filter(t=>t.value>0);
  makeChart('prodByTypeChart', {
    type: 'bar',
    data: {
      labels: byType.map(t=>t.type.replace(' SLA','').replace(' 30D','')),
      datasets: [{
        data: byType.map(t=>t.value),
        backgroundColor: C.types.slice(0, byType.length).map(c=>c+'AA'),
        borderColor: C.types.slice(0, byType.length),
        borderWidth: 1,
        borderRadius: 6,
        datalabels: barDL(v => fmt(v)),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: { tooltip: { callbacks: { label: ctx=>`Production: ${fmtFull(ctx.parsed.y)}` } } },
      ...barGridOpts(),
    },
  });

  // Monthly production — value labels above bars
  const monthMap = {};
  const allRows = getFilteredMetrics('all', tf);
  allRows.forEach(r=>{
    if (r.Metric!=='Daily Production' || !r.Value || !r.Date) return;
    const key = r.Date.substring(0,7); // yyyy-mm
    monthMap[key] = (monthMap[key]||0) + r.Value;
  });
  const monthEntries = Object.entries(monthMap).sort((a,b)=>a[0].localeCompare(b[0]));
  makeChart('prodMonthChart', {
    type: 'bar',
    data: {
      labels: monthEntries.map(([k])=>{
        const [y,m] = k.split('-');
        return new Date(y,m-1,1).toLocaleString('default',{month:'short',year:'2-digit'});
      }),
      datasets: [{
        data: monthEntries.map(([,v])=>v),
        backgroundColor: C.violet+'99',
        borderColor: C.violet,
        borderWidth: 1,
        borderRadius: 6,
        datalabels: barDL(v => fmt(v)),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36, right: 24, bottom: 8, left: 8 } },
      plugins: { tooltip: { callbacks: { label: ctx=>`Production: ${fmtFull(ctx.parsed.y)}` } } },
      scales: {
        x: { grid:{color:'rgba(80,9,181,0.07)'}, ticks:{color:'#7B74A0', font:{size:10}} },
        y: { grid:{color:'rgba(80,9,181,0.07)'}, ticks:{color:'#7B74A0', callback:v=>fmt(v)} },
      },
    },
  });
}

// ── PAGE 5: Trends & Forecasting ───────────────────────────
function renderTrendsPage() {
  const allMetrics = STATE.metricsData.filter(r=>r.Date && r.Date<=STATE.maxRealDate);
  const allSLA     = STATE.slaData.filter(r=>r.Date && r.Date<=STATE.maxRealDate);

  // Inventory + 30-day MA
  const invPts = sumByDateMetric(allMetrics,'Total');
  const invMA  = movingAverage(invPts, 30);

  // Inventory + 30-day MA — callouts on the MA line (smoother story)
  const invMAsp = storyPoints(invMA.filter(p=>p.y!=null).map((p,_,a)=>p));
  // Recompute indices in full invMA array
  const invMApeakIdx = invMA.reduce((best,p,i)=> p.y!=null && (best===-1||p.y>invMA[best].y) ? i : best, -1);
  const invMAlowIdx  = invMA.reduce((best,p,i)=> p.y!=null && (best===-1||p.y<invMA[best].y) ? i : best, -1);
  const invMAlastIdx = invMA.reduceRight((found,p,i)=> found===-1 && p.y!=null ? i : found, -1);
  const invMAmap = {};
  if (invMApeakIdx >= 0) invMAmap[invMApeakIdx] = 'Peak';
  if (invMAlowIdx  >= 0) invMAmap[invMAlowIdx]  = 'Low';
  if (invMAlastIdx >= 0) invMAmap[invMAlastIdx] = 'Current';

  makeChart('trendInvMAChart', {
    type: 'line',
    data: {
      datasets: [
        { label: 'Total Inventory', data: invPts, borderColor: C.violet+'88', borderWidth: 1.5,
          fill: true, backgroundColor: C.violet+'18', tension: 0.4, pointRadius: 0,
          datalabels: { display: false } },
        { label: '30-Day MA', data: invMA, borderColor: C.violet, borderWidth: 2.5,
          fill: false, backgroundColor: 'transparent', tension: 0.4, pointRadius: 0,
          borderDash: [],
          datalabels: timelineCalloutDL(invMA, v=>v!=null?fmt(v):'', invMAmap, C.violet) },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 56, bottom: 44, left: 8, right: 76 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color:'#4A4560', boxWidth:12, padding:16 } },
        tooltip: { callbacks: { title: tooltipTitle, label: ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
      },
      ...gridOpts(),
    },
  });

  // SLA + 7-day MA — callouts on MA line
  const slaPts = allSLA.map(r=>({x:r.Date,y:r.SLA_Pct*100})).sort((a,b)=>a.x.localeCompare(b.x));
  const slaMA  = movingAverage(slaPts, 7);
  const slaMApeakIdx = slaMA.reduce((best,p,i)=> p.y!=null && (best===-1||p.y>slaMA[best].y) ? i : best, -1);
  const slaMAlow  = slaMA.reduce((best,p,i)=> p.y!=null && (best===-1||p.y<slaMA[best].y) ? i : best, -1);
  const slaMALast = slaMA.reduceRight((found,p,i)=> found===-1 && p.y!=null ? i : found, -1);
  const slaMAmap = {};
  if (slaMApeakIdx >= 0) slaMAmap[slaMApeakIdx] = 'High';
  if (slaMAlow     >= 0) slaMAmap[slaMAlow]     = 'Low';
  if (slaMALast    >= 0) slaMAmap[slaMALast]    = 'Current';

  makeChart('trendSlaMAChart', {
    type: 'line',
    data: {
      datasets: [
        { label: 'Daily SLA%', data: slaPts, borderColor: C.teal+'88', borderWidth: 1.5,
          fill: true, backgroundColor: C.teal+'15', tension: 0.4, pointRadius: 0,
          datalabels: { display: false } },
        { label: '7-Day MA',   data: slaMA,  borderColor: C.teal, borderWidth: 2.5,
          fill: false, tension: 0.4, pointRadius: 0,
          datalabels: timelineCalloutDL(slaMA, v=>v!=null?v.toFixed(1)+'%':'', slaMAmap, C.teal) },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 56, bottom: 44, left: 8, right: 76 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color:'#4A4560', boxWidth:12, padding:16 } },
        tooltip: { callbacks: { title: tooltipTitle, label: ctx=>`${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}%` } },
      },
      ...gridOpts('',v=>v.toFixed(0)+'%'),
    },
  });

  // Stacked area: In SLA vs Out of SLA — callouts on each series
  const inPts  = sumByDateMetric(allMetrics,'IN SLA');
  const outPts = sumByDateMetric(allMetrics,'Out of SLA');
  const inSP   = storyPoints(inPts);
  const outSP  = storyPoints(outPts);
  const inMap  = {};
  const outMap = {};
  if (inSP.peakIdx  >= 0) inMap[inSP.peakIdx]   = 'Peak';
  if (inSP.lastIdx  >= 0) inMap[inSP.lastIdx]    = 'Current';
  if (outSP.peakIdx >= 0) outMap[outSP.peakIdx]  = 'Peak';
  if (outSP.lastIdx >= 0) outMap[outSP.lastIdx]  = 'Current';

  makeChart('trendStackChart', {
    type: 'line',
    data: {
      datasets: [
        { label: 'In SLA',     data: inPts,  borderColor: C.teal,     borderWidth: 1.5,
          fill: 'origin', backgroundColor: C.teal+'40', tension: 0.4, pointRadius: 0,
          datalabels: timelineCalloutDL(inPts, v=>fmt(v), inMap, C.teal) },
        { label: 'Out of SLA', data: outPts, borderColor: '#FA8072', borderWidth: 1.5,
          fill: 'origin', backgroundColor: '#FA807240', tension: 0.4, pointRadius: 0,
          datalabels: timelineCalloutDL(outPts, v=>fmt(v), outMap, '#FA8072') },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 56, bottom: 44, left: 8, right: 76 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color:'#4A4560', boxWidth:12, padding:16 } },
        tooltip: { callbacks: { title: tooltipTitle, label: ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
      },
      ...gridOpts(),
    },
  });

  // Populate executive insight panels from computed series
  renderTrendInsights(invPts, invMA, slaPts, slaMA, inPts, outPts);
}

// ── Executive Insight Engine ───────────────────────────────
// Populates the three insight panels on the Trends page.
// Reads only from pre-computed pts arrays — does not touch data model.
function renderTrendInsights(invPts, invMA, slaPts, slaMA, inPts, outPts) {

  // ── Helper: pct change string ─────────────────────────────
  function pctChange(from, to) {
    if (!from) return '—';
    const delta = ((to - from) / from) * 100;
    return (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%';
  }

  // ── Helper: trend direction from last N points of MA ─────
  function trendDir(maPts, window = 10) {
    const valid = maPts.filter(p => p.y != null);
    if (valid.length < 2) return 'stable';
    const recent = valid.slice(-window);
    const slope  = recent[recent.length - 1].y - recent[0].y;
    const pct    = Math.abs(slope / (valid[0].y || 1)) * 100;
    if (pct < 2) return 'stable';
    return slope > 0 ? 'rising' : 'falling';
  }

  // ── 1. Inventory Volume Insight ───────────────────────────
  {
    const valid   = invPts.filter(p => p.y != null);
    const peak    = valid.reduce((m, p) => p.y > m.y ? p : m, valid[0] || {y:0});
    const current = valid[valid.length - 1] || {y:0};
    const change  = pctChange(peak.y, current.y);
    const dir     = trendDir(invMA);

    const dirLabel = { rising: '↑ Rising', falling: '↓ Declining', stable: '→ Stable' }[dir];
    const dirCls   = { rising: 'negative', falling: 'positive', stable: '' }[dir];

    setEl('insight-inv-peak',    fmt(peak.y));
    setEl('insight-inv-current', fmt(current.y));

    const changeEl = document.getElementById('insight-inv-change');
    if (changeEl) {
      changeEl.textContent = change;
      changeEl.className   = 'insight-metric-value ' +
        (current.y < peak.y ? 'negative' : 'positive');
    }
    const trendEl = document.getElementById('insight-inv-trend');
    if (trendEl) { trendEl.textContent = dirLabel; trendEl.className = 'insight-metric-value ' + dirCls; }

    // Status badge
    const statusEl = document.getElementById('insight-inv-status');
    let statusTxt, statusCls, narrative;
    if (dir === 'rising') {
      statusTxt = 'GROWING';   statusCls = 'insight-status insight-status-watch';
      narrative = `Inventory volume is currently at ${fmt(current.y)} and trending upward. ` +
        `Peak inventory reached ${fmt(peak.y)}. Continued growth may require additional staffing capacity. Monitor closely.`;
    } else if (dir === 'falling') {
      statusTxt = 'DECLINING'; statusCls = 'insight-status insight-status-pass';
      narrative = `Inventory volume has declined from a peak of ${fmt(peak.y)} to a current level of ${fmt(current.y)} (${change}). ` +
        `The 30-day moving average confirms a sustained downward trend, indicating effective claim resolution.`;
    } else {
      statusTxt = 'STABLE';    statusCls = 'insight-status insight-status-stable';
      narrative = `Inventory volume has stabilized near ${fmt(current.y)}. Peak inventory reached ${fmt(peak.y)}. ` +
        `The 30-day moving average shows no sustained growth or decline — operations are holding steady.`;
    }
    if (statusEl) { statusEl.textContent = statusTxt; statusEl.className = statusCls; }
    setEl('insight-inv-text', narrative);
  }

  // ── 2. Enterprise SLA Insight ─────────────────────────────
  {
    const SLA_TARGET = 90;
    const validSla   = slaPts.filter(p => p.y != null);
    const currentSla = validSla[validSla.length - 1]?.y ?? 0;
    const low        = validSla.reduce((m, p) => p.y < m.y ? p : m, validSla[0] || {y:0});
    const variance   = (currentSla - SLA_TARGET).toFixed(1);
    const varStr     = (variance >= 0 ? '+' : '') + variance + '%';

    const varEl = document.getElementById('insight-sla-variance');
    if (varEl) {
      varEl.textContent = varStr;
      varEl.className   = 'insight-metric-value ' + (variance >= 0 ? 'positive' : 'negative');
    }
    setEl('insight-sla-current', currentSla.toFixed(1) + '%');
    setEl('insight-sla-low',     low.y.toFixed(1) + '%');

    const statusEl = document.getElementById('insight-sla-status');
    const passing  = currentSla >= SLA_TARGET;
    let statusTxt, statusCls, narrative;
    if (passing) {
      statusTxt = 'PASSING SLA'; statusCls = 'insight-status insight-status-pass';
      narrative = `Enterprise SLA is currently ${currentSla.toFixed(1)}%, which is ${varStr} above the 90% threshold. ` +
        `Performance has recovered from a historical low of ${low.y.toFixed(1)}% and is operating within acceptable bounds. ` +
        `No immediate action required.`;
    } else {
      statusTxt = 'FAILING SLA'; statusCls = 'insight-status insight-status-fail';
      narrative = `Enterprise SLA is currently ${currentSla.toFixed(1)}%, which is ${varStr} below the 90% threshold. ` +
        `The historical low was ${low.y.toFixed(1)}%. ` +
        `Immediate attention is required to identify and resolve the claim types driving SLA non-compliance.`;
    }
    if (statusEl) { statusEl.textContent = statusTxt; statusEl.className = statusCls; }
    setEl('insight-sla-text', narrative);
  }

  // ── 3. In SLA vs Out of SLA Insight ──────────────────────
  {
    const validIn   = inPts.filter(p => p.y != null);
    const validOut  = outPts.filter(p => p.y != null);
    const curIn     = validIn[validIn.length - 1]?.y   ?? 0;
    const curOut    = validOut[validOut.length - 1]?.y  ?? 0;
    const peakOut   = validOut.reduce((m, p) => p.y > m.y ? p : m, validOut[0] || {y:0});
    const total     = curIn + curOut;
    const outPctNum = total > 0 ? (curOut / total) * 100 : 0;
    const outPctStr = outPctNum.toFixed(1) + '%';

    setEl('insight-stack-insla',   fmt(curIn));
    setEl('insight-stack-outsla',  fmt(curOut));
    setEl('insight-stack-peakout', fmt(peakOut.y));

    const outPctEl = document.getElementById('insight-stack-pct');
    if (outPctEl) {
      outPctEl.textContent = outPctStr;
      outPctEl.className   = 'insight-metric-value ' + (outPctNum < 10 ? 'positive' : 'negative');
    }

    const statusEl = document.getElementById('insight-stack-status');
    let statusTxt, statusCls, narrative;
    if (outPctNum <= 5) {
      statusTxt = 'EXCELLENT';  statusCls = 'insight-status insight-status-pass';
      narrative = `In SLA inventory (${fmt(curIn)}) substantially exceeds Out of SLA inventory (${fmt(curOut)}). ` +
        `Out of SLA claims represent only ${outPctStr} of total inventory — well within acceptable limits. ` +
        `Operations are performing at an excellent level.`;
    } else if (outPctNum <= 10) {
      statusTxt = 'HEALTHY';    statusCls = 'insight-status insight-status-pass';
      narrative = `In SLA inventory (${fmt(curIn)}) continues to significantly exceed Out of SLA inventory (${fmt(curOut)}). ` +
        `Out of SLA claims represent ${outPctStr} of total inventory, which is within manageable bounds. ` +
        `Peak Out of SLA reached ${fmt(peakOut.y)}.`;
    } else if (outPctNum <= 20) {
      statusTxt = 'MONITOR';    statusCls = 'insight-status insight-status-watch';
      narrative = `Out of SLA inventory (${fmt(curOut)}) has risen to ${outPctStr} of total inventory. ` +
        `This is above the preferred threshold of 10%. Review claim types with highest Out of SLA concentrations and assess staffing capacity.`;
    } else {
      statusTxt = 'AT RISK';    statusCls = 'insight-status insight-status-fail';
      narrative = `Out of SLA inventory (${fmt(curOut)}) represents ${outPctStr} of total inventory — a critical level. ` +
        `Immediate intervention is required. Leadership should review escalation pathways and resource allocation.`;
    }
    if (statusEl) { statusEl.textContent = statusTxt; statusEl.className = statusCls; }
    setEl('insight-stack-text', narrative);
  }
}

// ── Navigation ─────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const page = link.dataset.page;
      document.querySelectorAll('.nav-item').forEach(l=>l.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
      link.classList.add('active');
      const pageEl = document.getElementById('page-'+page);
      if (pageEl) pageEl.classList.add('active');

      // Re-render on navigate to ensure charts resize correctly
      setTimeout(() => {
        if (page==='overview')    renderOverview();
        if (page==='inventory')   renderInventoryPage();
        if (page==='sla')         renderSLAPage();
        if (page==='production')  renderProductionPage();
        if (page==='trends')      renderTrendsPage();
        if (page==='validation')  renderValidationPage();
      }, 50);
    });
  });

  // Sidebar collapse
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      // Trigger chart resize
      setTimeout(() => {
        Object.values(STATE.charts).forEach(c => { try { c.resize(); } catch(e){} });
      }, 300);
    });
  }
}

// Close every open multi-picker dropdown (optionally except one)
function closeAllPickers(except) {
  document.querySelectorAll('.ms-picker-menu.open').forEach(m => {
    if (m !== except) m.classList.remove('open');
  });
}

// ── Date & Type Filters ────────────────────────────────────
// Maps page key to its render function
const PAGE_RENDERERS = {
  overview:   renderOverview,
  inventory:  renderInventoryPage,
  sla:        renderSLAPage,
  production: renderProductionPage,
};

function initFilters() {
  // ── Period pill buttons — shared across all pages ──────────
  // Each .filter-bar[data-page] fires its own page renderer.
  document.querySelectorAll('.filter-bar').forEach(bar => {
    const page = bar.dataset.page;
    const renderFn = PAGE_RENDERERS[page] || renderOverview;

    // Period pills
    bar.querySelectorAll('.btn-period').forEach(btn => {
      btn.addEventListener('click', () => {
        applyFilter(btn.dataset.period, renderFn);
      });
    });

    // Multi-select month picker
    const monthMenu  = bar.querySelector('.ms-month-menu');
    const monthBtn   = bar.querySelector('.ms-month-btn');
    const yearMenu   = bar.querySelector('.ms-year-menu');
    const yearBtn    = bar.querySelector('.ms-year-btn');

    monthBtn?.addEventListener('click', e => {
      e.stopPropagation();
      closeAllPickers(monthMenu);
      monthMenu?.classList.toggle('open');
    });
    yearBtn?.addEventListener('click', e => {
      e.stopPropagation();
      closeAllPickers(yearMenu);
      yearMenu?.classList.toggle('open');
    });
    // Keep menu open when clicking inside it
    monthMenu?.addEventListener('click', e => e.stopPropagation());
    yearMenu?.addEventListener('click',  e => e.stopPropagation());

    // Checkbox changes → multi-month filter
    monthMenu?.addEventListener('change', () => {
      STATE.selectedMonths = [...monthMenu.querySelectorAll('input:checked')].map(i => i.value);
      STATE.selectedYears  = [];
      if (STATE.selectedMonths.length) {
        applyFilter('months', renderFn);
      } else {
        applyFilter('latest', renderFn);   // empty selection → back to default
      }
    });
    yearMenu?.addEventListener('change', () => {
      STATE.selectedYears  = [...yearMenu.querySelectorAll('input:checked')].map(i => i.value);
      STATE.selectedMonths = [];
      if (STATE.selectedYears.length) {
        applyFilter('years', renderFn);
      } else {
        applyFilter('latest', renderFn);
      }
    });

    // Compare dropdown
    bar.querySelector('.filter-compare')?.addEventListener('change', e => {
      STATE.compare = e.target.value;
      document.querySelectorAll('.filter-compare').forEach(s => { s.value = e.target.value; });
      renderFn();
    });

    // Custom date range
    const fromInput = bar.querySelector('.filter-custom-from');
    const toInput   = bar.querySelector('.filter-custom-to');
    bar.querySelector('.filter-custom-apply')?.addEventListener('click', () => {
      if (!fromInput.value || !toInput.value) return;
      STATE.customStart = fromInput.value;
      STATE.customEnd   = toInput.value;
      // Sync custom inputs across pages
      document.querySelectorAll('.filter-custom-from').forEach(i => { i.value = STATE.customStart; });
      document.querySelectorAll('.filter-custom-to').forEach(i   => { i.value = STATE.customEnd;   });
      applyFilter('custom', renderFn);
    });
  });

  // Close all picker menus on outside click
  document.addEventListener('click', () => closeAllPickers());

  // ── Inventory Type filter (Overview only) ──────────────────
  document.getElementById('inventoryTypeFilter')?.addEventListener('change', e => {
    STATE.typeFilter = e.target.value;
    renderOverview();
  });

  // ── Production Type filter ─────────────────────────────────
  document.getElementById('prodTypeFilter')?.addEventListener('change', () => {
    renderProductionPage();
  });

  // ── Treemap / Risk Table tabs ──────────────────────────────
  document.getElementById('tab-treemap')?.addEventListener('click', () => {
    document.getElementById('tab-treemap').classList.add('active');
    document.getElementById('tab-risk').classList.remove('active');
    document.getElementById('treemap-view').classList.remove('hidden');
    document.getElementById('risk-view').classList.add('hidden');
  });
  document.getElementById('tab-risk')?.addEventListener('click', () => {
    document.getElementById('tab-risk').classList.add('active');
    document.getElementById('tab-treemap').classList.remove('active');
    document.getElementById('risk-view').classList.remove('hidden');
    document.getElementById('treemap-view').classList.add('hidden');
  });
}

// ── PAGE 6: Data Validation ────────────────────────────────
function renderValidationPage() {
  const typeVal   = document.getElementById('valTypeFilter')?.value   || 'all';
  const metricVal = document.getElementById('valMetricFilter')?.value || 'all';
  const dateFrom  = document.getElementById('valDateFrom')?.value     || '';
  const dateTo    = document.getElementById('valDateTo')?.value       || '';

  let rows = STATE.metricsData.slice();

  // Apply filters
  if (typeVal   !== 'all') rows = rows.filter(r => r.InventoryType === typeVal);
  if (metricVal !== 'all') rows = rows.filter(r => r.Metric        === metricVal);
  if (dateFrom)            rows = rows.filter(r => r.Date >= dateFrom);
  if (dateTo)              rows = rows.filter(r => r.Date <= dateTo);

  // Sort by Date, then InventoryType, then Metric
  rows.sort((a, b) => a.Date.localeCompare(b.Date) || a.InventoryType.localeCompare(b.InventoryType) || a.Metric.localeCompare(b.Metric));

  // Summary bar
  const totalVal    = rows.reduce((s, r) => s + (r.Value || 0), 0);
  const dates       = [...new Set(rows.map(r => r.Date))].filter(Boolean).sort();
  const dateRangeStr = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—';
  setEl('val-rowcount',    rows.length.toLocaleString());
  setEl('val-sumval',      fmtFull(totalVal));
  setEl('val-daterange',   dateRangeStr);
  setEl('val-uniquedates', dates.length.toLocaleString());
  setEl('val-showing',     `Showing ${Math.min(rows.length, 2000).toLocaleString()} of ${rows.length.toLocaleString()} rows`);

  // Reconciliation matrix — sum by type × core metric (respects date/type filters)
  const matrixRows = STATE.metricsData.filter(r => {
    if (typeVal !== 'all' && r.InventoryType !== typeVal) return false;
    if (dateFrom && r.Date < dateFrom) return false;
    if (dateTo   && r.Date > dateTo)   return false;
    return true;
  });

  const coreMetrics = ['Total', 'IN SLA', 'Out of SLA', 'Daily Production'];
  const typesToShow = typeVal === 'all' ? INV_TYPES : [typeVal];
  const matrixBody = document.getElementById('valMatrixBody');
  if (matrixBody) {
    let grandRow = { Total: 0, 'IN SLA': 0, 'Out of SLA': 0, 'Daily Production': 0 };
    matrixBody.innerHTML = typesToShow.map(t => {
      const totals = {};
      coreMetrics.forEach(m => {
        totals[m] = matrixRows.filter(r => r.InventoryType === t && r.Metric === m).reduce((s, r) => s + (r.Value || 0), 0);
        grandRow[m] = (grandRow[m] || 0) + totals[m];
      });
      const slaPct = totals['Total'] > 0 ? (totals['IN SLA'] / totals['Total'] * 100).toFixed(1) + '%' : '—';
      return `<tr>
        <td>${t}</td>
        <td style="text-align:right">${fmtFull(totals['Total'])}</td>
        <td style="text-align:right">${fmtFull(totals['IN SLA'])}</td>
        <td style="text-align:right">${fmtFull(totals['Out of SLA'])}</td>
        <td style="text-align:right">${fmtFull(totals['Daily Production'])}</td>
        <td style="text-align:right">${slaPct}</td>
      </tr>`;
    }).join('') + (typesToShow.length > 1 ? `<tr style="font-weight:800;border-top:2px solid rgba(80,9,181,0.3);background:#EBE4FF">
        <td>GRAND TOTAL</td>
        <td style="text-align:right;color:#5009B5">${fmtFull(grandRow['Total'])}</td>
        <td style="text-align:right;color:#007F7F">${fmtFull(grandRow['IN SLA'])}</td>
        <td style="text-align:right;color:#C94A3A">${fmtFull(grandRow['Out of SLA'])}</td>
        <td style="text-align:right;color:#1A7AAF">${fmtFull(grandRow['Daily Production'])}</td>
        <td style="text-align:right">${grandRow['Total'] > 0 ? (grandRow['IN SLA']/grandRow['Total']*100).toFixed(1)+'%' : '—'}</td>
      </tr>` : '');
  }

  // Raw table — cap at 2000 rows for browser performance
  const rawBody = document.getElementById('valRawBody');
  if (rawBody) {
    const display = rows.slice(0, 2000);
    rawBody.innerHTML = display.map((r, i) =>
      `<tr>
        <td style="color:var(--text-muted);font-size:11px">${i + 1}</td>
        <td>${r.Date}</td>
        <td>${r.InventoryType}</td>
        <td>${r.Metric}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtFull(r.Value)}</td>
      </tr>`
    ).join('');
  }
}

function initValidationFilters() {
  // Set default date range to current calendar month
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const firstDay = `${y}-${String(m + 1).padStart(2,'0')}-01`;
  const lastDay  = new Date(y, m + 1, 0);
  const lastStr  = `${y}-${String(m + 1).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`;
  const fromEl = document.getElementById('valDateFrom');
  const toEl   = document.getElementById('valDateTo');
  if (fromEl && !fromEl.value) fromEl.value = firstDay;
  if (toEl   && !toEl.value)   toEl.value   = lastStr;

  document.getElementById('valApplyBtn')?.addEventListener('click', renderValidationPage);
  document.getElementById('valTypeFilter')?.addEventListener('change', renderValidationPage);
  document.getElementById('valMetricFilter')?.addEventListener('change', renderValidationPage);
}

// ── Bootstrap ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initFilters();
  initValidationFilters();
  loadData().catch(err => {
    console.error('CATALYST data error:', err);
    document.getElementById('loadingOverlay').innerHTML =
      `<div style="color:#C94A3A;text-align:center;padding:40px;font-family:Segoe UI,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">⚠</div>
        <h2 style="color:#C94A3A;font-size:20px;">Data file missing</h2>
        <p style="margin-top:12px;color:#4A4560;max-width:400px;">
          Ensure <strong style="color:#231E33;">data.js</strong> is in the same folder as CATALYST.html.<br><br>
          Run <strong style="color:#5009B5;">Refresh_CATALYST.ps1</strong> to regenerate it from Excel.
        </p>
        <p style="margin-top:12px;font-size:11px;color:#7B74A0;">${err.message}</p>
      </div>`;
  });
});
