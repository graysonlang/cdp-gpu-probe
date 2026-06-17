// HUD renderer — pure presentation, no data source.
//
// createHudRenderer(root, { charts }) wires up the dashboard DOM under `root` and returns
// methods that take already-decoded payloads:
//   renderInfo(info)     one-time GPU identity (header)
//   renderSample(sample) one memory sample per tick (tables + opt-in charts)
//   setLive(bool)        connection indicator
//   setStatus(message)   transient status message
//   redraw()             re-draw the charts (e.g. on resize)
//
// One layout for everyone: a header, an optional charts strip, and the footprints +
// allocator-rollups + largest-resources tables. Each footprint/rollup row has a leftmost
// checkbox that toggles a sparkline chart for that metric — so the "graphical" and "text"
// HUDs are the same thing, differing only in which charts start ticked (`{ charts:false }`
// / ?text starts with none). It has no idea where the data comes from: the CLI feeds it
// from an SSE EventSource (see hud.js); the direct HUD feeds the same methods over CDP.

// Charts plot {t, value} points against a shared, fixed time window, so every tile uses the
// same horizontal time axis and inflections line up across them — and a slow (rollup) series
// and a fast (footprint) series stay aligned even at different cadences.
const WINDOW_MS = 60_000; // chart time window
const MAX_POINTS = 1200; // hard cap on stored points per series (memory safety)

// Authoritative, kernel-reported process footprints (from the dump's process_totals),
// carried on the sample as gpuProcessFootprintBytes / rendererFootprintBytes rather than
// as allocator rollups. These are the headline — they capture GPU/Metal memory the
// self-reported breakdown misses — so a chart of one gets its own (own-peak) scale.
const SPECIAL = {
  footprint: { label: 'GPU process footprint', field: 'gpuProcessFootprintBytes' },
  renderer: { label: 'Renderer footprint', field: 'rendererFootprintBytes' },
};
const SPECIAL_KEYS = Object.keys(SPECIAL);

// Friendly labels for memory-infra rollup nodes — the interesting bucket differs by
// backend: GL textures/buffers on SwiftShader/Linux, shared_images (where macOS Metal/ANGLE
// puts IOSurface-backed textures), and dawn for WebGPU. These are Chrome's self-reported
// breakdown, secondary to the footprint headline.
const ROLLUP_LABELS = {
  'gpu': 'GPU allocators (reported)',
  'gpu/gl/textures': 'Textures (GL)',
  'gpu/gl/buffers': 'Buffers (GL)',
  'gpu/gl/renderbuffers': 'Renderbuffers',
  'gpu/shared_images': 'Images / IOSurfaces',
  'gpu/transfer_memory': 'GPU transfer (Dawn/IPC)',
  'gpu/transfer_cache': 'Transfer cache',
  'gpu/shader_cache': 'Shader cache',
  'gpu/dawn': 'WebGPU (Dawn)',
  'skia/gpu_resources': 'Skia',
  'cc/tile_memory': 'Compositor tiles',
};

const labelFor = key => SPECIAL[key]?.label || ROLLUP_LABELS[key] || key;
// Friendly name for a rollup line item, or '' when there's no distinct friendly name
// (unknown node) so callers can show the raw key alone instead of duplicating it.
export const friendlyName = key => (labelFor(key) === key ? '' : labelFor(key));

function cell(className, value, title) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = value;
  if (title) td.title = title; // full text on hover, since these cells truncate (ellipsis)
  return td;
}

const MiB = 1024 * 1024;

// The chart line, the value, and the peak are colored by their magnitude (not direction):
// green is calm, purple is huge. Thresholds: <150 MiB green, <350 yellow, <500 orange,
// <1 GiB red, else purple.
const BUCKETS = [
  { max: 150 * MiB, stroke: '#3fb950', fill: 'rgba(63, 185, 80, 0.10)' },
  { max: 350 * MiB, stroke: '#d29922', fill: 'rgba(210, 153, 34, 0.12)' },
  { max: 500 * MiB, stroke: '#db6d28', fill: 'rgba(219, 109, 40, 0.12)' },
  { max: 1024 * MiB, stroke: '#f85149', fill: 'rgba(248, 81, 73, 0.12)' },
  { max: Infinity, stroke: '#a371f7', fill: 'rgba(163, 113, 247, 0.14)' },
];
function bucketColor(bytes) {
  return BUCKETS.find(b => bytes < b.max) ?? BUCKETS.at(-1);
}

// Direction of the per-sample change, for the Δ text (up = grew, down = shrank, flat = none).
function trendOf(delta) {
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
}

function humanBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

// Per-sample change, PerfMon-style: an arrow + magnitude of the delta from the
// previous sample. `null` (no previous sample yet) renders as a dash.
function stepLabel(step) {
  if (!step) return '–'; // grey en dash for no change (or no prior sample yet)
  return `${step > 0 ? '▲' : '▼'} ${humanBytes(Math.abs(step))}`;
}

// Draws the {t, value} points against the shared time window [now - WINDOW_MS, now] (so all
// tiles share one horizontal time axis) and a shared `scaleMax` for height (so magnitudes are
// comparable). `dots` marks the actual sample points — the cadence cue for slow (rollup)
// series, where the line is sparse; on a dense footprint line they blend in.
function drawSparkline(canvas, points, colors, scaleMax, peak, now, dots) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth * ratio;
  const height = canvas.clientHeight * ratio;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  // willReadFrequently keeps this canvas on the CPU raster path instead of a
  // GPU-backed surface — so the HUD's own sparklines don't add to the GPU memory it
  // measures (matters most for the direct HUD, which shares the measured GPU process).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  if (points.length < 2) return;

  const top = scaleMax > 0 ? scaleMax : (Math.max(...points.map(p => p.v)) || 1);
  const pad = 4 * ratio;
  const t0 = now - WINDOW_MS;
  const x = t => pad + ((t - t0) / WINDOW_MS) * (width - pad * 2);
  const y = v => height - pad - (Math.min(v, top) / top) * (height - pad * 2);

  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.t);
    const py = y(p.v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = 1.5 * ratio;
  ctx.stroke();

  // Fill under the line for a touch of weight.
  ctx.lineTo(x(points.at(-1).t), height - pad);
  ctx.lineTo(x(points[0].t), height - pad);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();

  // Sample-point dots — visible where the line is sparse (slow cadence), subtle where dense.
  if (dots) {
    ctx.fillStyle = colors.stroke;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(x(p.t), y(p.v), 1.8 * ratio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Dotted session-peak reference line — the chart's high-water mark, on the shared scale,
  // so you can read how far the current value sits below its peak.
  if (peak > 0) {
    const py = y(peak);
    ctx.save();
    ctx.setLineDash([3 * ratio, 3 * ratio]);
    ctx.strokeStyle = bucketColor(peak).stroke; // peak line follows the peak's magnitude band
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1 * ratio;
    ctx.beginPath();
    ctx.moveTo(pad, py);
    ctx.lineTo(width - pad, py);
    ctx.stroke();
    ctx.restore();
  }
}

// Shared status header (#conn / #meta / #identity + the live dot) and connection phase.
//   line 1 (#conn): connection state word + the target host:port in parens.
//   #meta: a transient status message (reconnecting, sample skipped), else the initial
//          "waiting…" until the first sample, then empty.
function createStatusHeader(root) {
  let phase = 'connecting'; // connecting | live | disconnected — drives line 1's state word
  let statusMessage = '';
  let targetLabel = '';
  let started = false;

  function renderStatus() {
    const conn = root.querySelector('#conn');
    if (conn) conn.textContent = targetLabel ? `${phase} (${targetLabel})` : phase;
    const meta = root.querySelector('#meta');
    if (!meta) return;
    meta.textContent = statusMessage || (started ? '' : 'waiting for first sample…');
  }

  return {
    // A fresh sample arrived: clear any transient note.
    noteSample() {
      started = true;
      statusMessage = '';
      renderStatus();
    },
    // Just the GL_RENDERER string (the part that varies); the host/model is omitted.
    renderInfo(info) {
      const active = (info.devices || []).find(d => d.active) || (info.devices || [])[0] || {};
      const identity = root.querySelector('#identity');
      if (identity) identity.textContent = info.gl?.renderer || active.device || 'unknown GPU';
    },
    // The target's url is already a concise label (e.g. "127.0.0.1:9222"); an optional
    // title prefixes it. Shown in parens after the state word, not as a mode.
    renderTarget(target) {
      targetLabel = [target.title, target.url].filter(Boolean).join(' · ') || '';
      renderStatus();
    },
    setLive(isLive) {
      phase = isLive ? 'live' : 'disconnected';
      root.querySelector('#status-dot')?.classList.toggle('live', isLive);
      renderStatus();
    },
    setStatus(message) {
      statusMessage = message || '';
      renderStatus();
    },
  };
}

export function createHudRenderer(root = document, options = {}) {
  const header = createStatusHeader(root);
  const tilesEl = root.querySelector('#tiles');

  const series = new Map(); // metric key -> [{ t, v }] over the shared time window
  const peakOf = new Map(); // metric key -> session high-water mark
  const charted = new Set(); // keys whose chart is shown (checkbox ticked)
  const tiles = new Map(); // key -> { root, value, delta, canvas }
  const metrics = new Map(); // current value per key (persistent; footprints fast, rollups slow)
  let rollupKeys = []; // rollup keys from the last DETAILED sample, for the table
  let lastSample = null; // the whole last detailed sample, for the copy/download buttons
  let footprintHz = null; // nominal cadences from the sample's configured intervals
  let detailHz = null;
  let sortCol = 'value';
  let sortDir = -1; // -1 desc, 1 asc

  // The configured cadence next to each section title (e.g. "Footprints – 1 Hz") — the rate
  // you asked for, not the jittery observed throughput. The rollups rate shows only when it
  // differs from the footprint rate (two-rate); single-rate shows just the one on Footprints.
  function fmtRate(hz) {
    if (!hz) return '';
    return ` – ${Math.round(hz * 100) / 100} Hz`;
  }
  function renderRates() {
    const fr = root.querySelector('#footprints-rate');
    if (fr) fr.textContent = fmtRate(footprintHz);
    const rr = root.querySelector('#rollups-rate');
    if (rr) rr.textContent = detailHz && detailHz !== footprintHz ? fmtRate(detailHz) : '';
  }

  // Default-chart the footprints, unless the caller opted out (?text / { charts: false }).
  if (options.charts !== false) for (const key of SPECIAL_KEYS) charted.add(key);

  // --- time series ---------------------------------------------------------------------
  // Fold a {t, value} into the series + peak (trim by the time window) and update the
  // current-value map the tables read. Only called for a metric when it has fresh data.
  function ingest(key, value, ts) {
    let points = series.get(key);
    if (!points) {
      points = [];
      series.set(key, points);
    }
    const prev = points.at(-1)?.v;
    points.push({ t: ts, v: value });
    const cutoff = ts - WINDOW_MS;
    while (points.length > 1 && points[0].t < cutoff) points.shift();
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    if (value > (peakOf.get(key) ?? 0)) peakOf.set(key, value);
    metrics.set(key, { value, step: prev === undefined ? null : value - prev, peak: peakOf.get(key) });
  }

  // --- charts (sparkline tiles for the ticked metrics) ---------------------------------
  function makeTile(key) {
    const tile = document.createElement('div');
    tile.className = 'tile trend-flat';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = labelFor(key);
    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = '—';
    const delta = document.createElement('div');
    delta.className = 'delta flat';
    delta.textContent = ' ';
    // Δ on the left, the peak (caret-prefixed) right-aligned on the same row.
    const peak = document.createElement('div');
    peak.className = 'peak-chip';
    peak.textContent = ' ';
    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    meta.append(delta, peak);
    const canvas = document.createElement('canvas');
    tile.append(label, value, meta, canvas);
    tilesEl.appendChild(tile);
    tiles.set(key, { root: tile, value, delta, peak, canvas });
  }

  // Rollup charts share one y-axis (their session peak) so they're comparable; footprint
  // charts get their own (own-peak) scale since they're far larger and a different metric.
  function rollupScaleMax() {
    let max = 0;
    for (const key of charted) {
      if (!SPECIAL[key]) max = Math.max(max, peakOf.get(key) ?? 0);
    }
    return max || 1;
  }

  // Redraw every tile against `now` so they all scroll together (even a slow rollup tile
  // scrolls between its samples, staying time-aligned with the fast footprint tiles).
  function drawCharts(now = Date.now()) {
    if (!tilesEl) return;
    const rollupTop = rollupScaleMax();
    for (const [key, els] of tiles) {
      const points = series.get(key) ?? [];
      const value = points.at(-1)?.v ?? 0;
      const step = points.length > 1 ? value - points.at(-2).v : null;
      const trend = trendOf(step ?? 0);
      const bucket = bucketColor(value);
      const peak = peakOf.get(key) ?? 0;
      els.value.textContent = humanBytes(value);
      els.value.style.color = bucket.stroke;
      els.delta.textContent = stepLabel(step);
      els.delta.className = `delta ${trend}`;
      els.peak.textContent = `^ ${humanBytes(peak)}`;
      els.peak.style.color = bucketColor(peak).stroke;
      els.root.className = 'tile';
      els.root.style.borderLeftColor = bucket.stroke;
      const top = SPECIAL[key] ? (peak || 1) : rollupTop;
      drawSparkline(els.canvas, points, bucket, top, peak, now, !SPECIAL[key]);
    }
  }

  function syncCharts() {
    if (!tilesEl) return;
    // A chart can only exist once its metric has data — so a ticked-but-unseen key (a
    // default renderer footprint a page never reports) simply has no tile.
    for (const key of charted) {
      if (!tiles.has(key) && series.has(key)) makeTile(key);
    }
    tilesEl.style.display = tiles.size ? '' : 'none';
  }

  function setCharted(key, on) {
    if (on === charted.has(key)) return;
    if (on) {
      charted.add(key);
    } else {
      charted.delete(key);
      tiles.get(key)?.root.remove();
      tiles.delete(key);
    }
    syncCharts();
    drawCharts();
  }

  // One delegated handler for every row's chart checkbox.
  root.addEventListener('change', (event) => {
    const box = event.target;
    if (box.matches?.('input[type="checkbox"][data-key]')) setCharted(box.dataset.key, box.checked);
  });

  // --- tables --------------------------------------------------------------------------
  function checkboxCell(key) {
    const td = document.createElement('td');
    td.className = 'chart';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = charted.has(key);
    box.dataset.key = key;
    td.append(box);
    return td;
  }

  // The trailing value/Δ/peak cells, shared by both tables. The value carries the same
  // magnitude color as its chart; the Δ keeps the direction color.
  function valueCells(m) {
    const trend = trendOf(m.step ?? 0);
    const valueCell = cell('num', humanBytes(m.value));
    valueCell.style.color = bucketColor(m.value).stroke;
    const peakCell = cell('peak', humanBytes(m.peak));
    peakCell.style.color = bucketColor(m.peak).stroke;
    return [
      valueCell,
      cell(`delta ${trend}`, stepLabel(m.step)),
      peakCell,
    ];
  }

  function renderFootprints() {
    const tbody = root.querySelector('#footprints');
    if (!tbody) return;
    tbody.replaceChildren();
    for (const key of SPECIAL_KEYS) {
      if (!metrics.has(key)) continue;
      const tr = document.createElement('tr');
      tr.append(checkboxCell(key), cell('friendly', SPECIAL[key].label, SPECIAL[key].label), ...valueCells(metrics.get(key)));
      tbody.appendChild(tr);
    }
  }

  function sortKey(key) {
    const m = metrics.get(key);
    switch (sortCol) {
      case 'friendly': return friendlyName(key) || key;
      case 'delta': return m.step ?? 0;
      case 'peak': return m.peak;
      default: return m.value;
    }
  }

  function renderAllocTable() {
    const tbody = root.querySelector('#rollups');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!rollupKeys.length) {
      const tr = document.createElement('tr');
      tr.append(cell('chart', ''), cell('friendly', 'no rollups reported'), cell('num', ''), cell('delta flat', ''), cell('peak', ''));
      tbody.appendChild(tr);
    } else {
      const sorted = [...rollupKeys].sort((a, b) => {
        const av = sortKey(a);
        const bv = sortKey(b);
        if (typeof av === 'string') return sortDir * av.localeCompare(bv);
        return sortDir * (av - bv);
      });
      for (const key of sorted) {
        const tr = document.createElement('tr');
        // One name column: the friendly label (or the node when there's none), with the
        // full node path on hover so the narrow window doesn't need a second column.
        tr.append(checkboxCell(key), cell('friendly', friendlyName(key) || key, key), ...valueCells(metrics.get(key)));
        tbody.appendChild(tr);
      }
    }
    for (const th of root.querySelectorAll('#alloc-table thead th')) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === sortCol) th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
    }
  }

  // Same column toggles direction; a new one sorts text ascending / numbers descending.
  for (const th of root.querySelectorAll('#alloc-table thead th.sortable')) {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = -sortDir;
      } else {
        sortCol = col;
        sortDir = col === 'friendly' || col === 'name' ? 1 : -1;
      }
      renderAllocTable();
    });
  }

  function renderTopTextures(textures) {
    const heading = root.querySelector('#top-heading');
    const tbody = root.querySelector('#top-textures');
    if (!heading || !tbody) return;
    if (!textures.length) {
      heading.style.display = 'none';
      tbody.replaceChildren();
      return;
    }
    heading.style.display = '';
    tbody.replaceChildren();
    for (const texture of textures) {
      const tr = document.createElement('tr');
      tr.append(cell('name', texture.name, texture.name), cell('num', humanBytes(texture.bytes)));
      tbody.appendChild(tr);
    }
  }

  function renderSample(sample) {
    const ts = sample.ts ?? Date.now();
    const detailed = sample.detailed !== false; // single-rate samples (no flag) are detailed
    if (sample.footprintIntervalMs) footprintHz = 1000 / sample.footprintIntervalMs;
    if (sample.detailIntervalMs) detailHz = 1000 / sample.detailIntervalMs;

    // Footprints update every tick (fast cadence in two-rate mode).
    ingest('footprint', sample.gpuProcessFootprintBytes || 0, ts);
    if (sample.rendererFootprintBytes) ingest('renderer', sample.rendererFootprintBytes, ts);
    renderFootprints();
    renderRates();

    // The full rollups + per-resource only arrive on detailed ticks; between them the
    // table/charts hold their last detailed values (background under-reports gpu/*).
    if (detailed) {
      lastSample = sample;
      const rollups = sample.rollups || {};
      rollupKeys = Object.keys(rollups);
      for (const [key, value] of Object.entries(rollups)) ingest(key, value, ts);
      renderAllocTable();
      renderTopTextures(sample.topTextures || []);
    }

    syncCharts();
    drawCharts(); // every tick, so all tiles scroll together on the shared time axis
    header.noteSample();
  }

  // --- toolbar: copy current stats / download the full raw GPU dump --------------------
  // The two tables (footprints + rollups) as a compact JSON blob — value + peak in bytes,
  // no deltas — for the Copy stats button.
  function statsJson() {
    const s = lastSample;
    const entry = (key, value) => ({ value, peak: peakOf.get(key) ?? value });
    const footprints = { [SPECIAL.footprint.label]: entry('footprint', s.gpuProcessFootprintBytes || 0) };
    if (s.rendererFootprintBytes) footprints[SPECIAL.renderer.label] = entry('renderer', s.rendererFootprintBytes);
    const rollups = {};
    for (const [key, value] of Object.entries(s.rollups || {})) rollups[key] = entry(key, value);
    return JSON.stringify({ footprints, rollups }, null, 2);
  }

  function flash(button, message) {
    const original = button.dataset.label ?? button.textContent;
    button.dataset.label = original;
    button.textContent = message;
    setTimeout(() => {
      button.textContent = button.dataset.label;
    }, 1200);
  }

  const copyBtn = root.querySelector('#copy-stats');
  const downloadBtn = root.querySelector('#download-json');
  copyBtn?.addEventListener('click', async () => {
    if (!lastSample) return;
    try {
      await navigator.clipboard.writeText(statsJson());
      flash(copyBtn, 'Copied!');
    } catch {
      flash(copyBtn, 'Copy failed');
    }
  });
  downloadBtn?.addEventListener('click', () => {
    if (!lastSample) return;
    // lastSample carries the raw GPU-process allocator dump + process_totals (includeRaw).
    const blob = new Blob([JSON.stringify(lastSample, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gpu-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  syncCharts(); // hide the (empty) charts strip until something is ticked + has data

  return {
    renderInfo: header.renderInfo,
    renderSample,
    renderTarget: header.renderTarget,
    setLive: header.setLive,
    setStatus: header.setStatus,
    redraw: () => drawCharts(),
  };
}
