// HUD scaffold: the single source of the dashboard's markup + styles, shared by
// both delivery modes. mountHud(root) injects a `.cdp-gpu-hud` container (and, once,
// the stylesheet) and returns that container for createHudRenderer() to populate.
//
// Everything is scoped under `.cdp-gpu-hud` so the HUD overlay can drop into a
// host app without its bare `body`/`table`/`canvas` rules leaking onto the page.

const STYLE_ID = 'cdp-gpu-hud-styles';

const STYLES = `
.cdp-gpu-hud {
  --bg: #0e1116; --panel: #161b22; --line: #232a33; --text: #e6edf3;
  --muted: #8b949e; --accent: #4cc2ff; --up: #ff7b72; --down: #3fb950;
  background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.4;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.cdp-gpu-hud * { box-sizing: border-box; }
.cdp-gpu-hud .hud-header {
  padding: 14px 20px 8px;
  display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
}
.cdp-gpu-hud .hud-status {
  display: flex; align-items: center; font-size: 14px; font-weight: 600;
  word-break: break-all;
}
.cdp-gpu-hud .dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%;
  background: var(--muted); margin-right: 8px; flex: none;
}
.cdp-gpu-hud .dot.live { background: var(--down); box-shadow: 0 0 8px var(--down); }
.cdp-gpu-hud .id { color: var(--muted); font-size: 12px; }
.cdp-gpu-hud #identity { font-size: 10px; }
.cdp-gpu-hud .hud-actions { display: flex; gap: 8px; flex: none; }
.cdp-gpu-hud .hud-actions button {
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: 5px; padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer;
}
.cdp-gpu-hud .hud-actions button:hover { border-color: var(--muted); }
.cdp-gpu-hud .hud-actions button:active { background: var(--line); }
.cdp-gpu-hud .hud-footer { padding: 4px 20px 12px; display: flex; flex-direction: column; gap: 4px; }
.cdp-gpu-hud .hud-tiles {
  padding: 4px 20px 16px; display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
.cdp-gpu-hud .tile {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--line);
  border-radius: 10px; padding: 14px 16px; transition: border-left-color .35s ease;
}
.cdp-gpu-hud .tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.cdp-gpu-hud .tile .value { font-size: 26px; font-weight: 600; margin-top: 4px; }
.cdp-gpu-hud .tile .value small { font-size: 14px; color: var(--muted); font-weight: 400; }
.cdp-gpu-hud .tile .tile-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-top: 2px; }
.cdp-gpu-hud .tile .delta { font-size: 12px; min-height: 16px; }
.cdp-gpu-hud .tile .peak-chip { font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cdp-gpu-hud .delta.up { color: var(--up); }
.cdp-gpu-hud .delta.down { color: var(--down); }
.cdp-gpu-hud .delta.flat { color: var(--muted); }
.cdp-gpu-hud canvas { display: block; width: 100%; height: 48px; margin-top: 10px; }
.cdp-gpu-hud .extra { padding: 0 20px 6px; color: var(--muted); }
.cdp-gpu-hud .extra h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
.cdp-gpu-hud .h2-rate { text-transform: none; letter-spacing: normal; font-variant-numeric: tabular-nums; }
/* table-layout: fixed so the numeric columns keep a stable width as values change
   magnitude (the text columns flex; numbers never reshuffle the layout). */
.cdp-gpu-hud table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
.cdp-gpu-hud td { padding: 3px 0; border-bottom: 1px solid var(--line); }
.cdp-gpu-hud td.num { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cdp-gpu-hud td.friendly { color: var(--text); padding-right: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdp-gpu-hud td.name { color: var(--muted); padding-right: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdp-gpu-hud td.delta { text-align: right; padding-left: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cdp-gpu-hud td.peak { text-align: right; padding-left: 14px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cdp-gpu-hud th {
  text-align: left; padding: 3px 0 5px; border-bottom: 1px solid var(--line);
  color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600;
}
.cdp-gpu-hud th.num, .cdp-gpu-hud th.delta, .cdp-gpu-hud th.peak { text-align: right; }
/* Pinned widths for the checkbox + numeric columns; friendly/name share the rest. */
.cdp-gpu-hud th.chart, .cdp-gpu-hud td.chart { width: 2em; padding-right: 8px; }
.cdp-gpu-hud th.num, .cdp-gpu-hud td.num { width: 5.5em; }
.cdp-gpu-hud th.delta, .cdp-gpu-hud td.delta { width: 7em; }
.cdp-gpu-hud th.peak, .cdp-gpu-hud td.peak { width: 6em; }
.cdp-gpu-hud th.sortable { cursor: pointer; user-select: none; }
.cdp-gpu-hud th.sortable:hover { color: var(--text); }
.cdp-gpu-hud th.sort-asc::after { content: " ▲"; font-size: 9px; }
.cdp-gpu-hud th.sort-desc::after { content: " ▼"; font-size: 9px; }
/* On-theme checkbox: a dark box that fills with the accent + a check when ticked. */
.cdp-gpu-hud td.chart input {
  appearance: none; display: block; box-sizing: border-box; position: relative;
  width: 14px; height: 14px; margin: 0; cursor: pointer;
  border: 1px solid var(--line); border-radius: 3px; background: var(--bg);
}
.cdp-gpu-hud td.chart input:hover { border-color: var(--muted); }
.cdp-gpu-hud td.chart input:checked { background: var(--accent); border-color: var(--accent); }
.cdp-gpu-hud td.chart input:checked::after {
  content: "✓"; position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--bg);
}
`;

// One scaffold for the whole HUD: a status header, a charts strip (sparkline tiles for the
// metrics whose leftmost checkbox is ticked — hidden until something is ticked), then the
// footprints + allocator-rollups + largest-resources tables. Each footprint/rollup row's
// first column is a checkbox that toggles its chart. createHudRenderer() populates it.
const MARKUP = `
  <div class="hud-header">
    <div class="hud-status"><span class="dot" id="status-dot"></span><span id="conn">connecting…</span></div>
    <div class="hud-actions">
      <button id="copy-stats" type="button">Copy stats</button>
      <button id="download-json" type="button">Download JSON</button>
    </div>
  </div>
  <div class="hud-tiles" id="tiles"></div>
  <div class="extra">
    <h2>Footprints<span class="h2-rate" id="footprints-rate"></span></h2>
    <table>
      <thead><tr>
        <th class="chart"></th>
        <th class="friendly">Metric</th>
        <th class="num">Value</th>
        <th class="delta">Delta</th>
        <th class="peak">Peak</th>
      </tr></thead>
      <tbody id="footprints"></tbody>
    </table>
    <h2 style="margin-top:18px;">Allocator rollups<span class="h2-rate" id="rollups-rate"></span></h2>
    <table id="alloc-table">
      <thead><tr>
        <th class="chart"></th>
        <th class="friendly sortable" data-col="friendly">Allocator</th>
        <th class="num sortable" data-col="value">Value</th>
        <th class="delta sortable" data-col="delta">Delta</th>
        <th class="peak sortable" data-col="peak">Peak</th>
      </tr></thead>
      <tbody id="rollups"></tbody>
    </table>
    <h2 id="top-heading" style="margin-top:18px; display:none;">Largest GPU resources</h2>
    <table><tbody id="top-textures"></tbody></table>
  </div>
  <div class="hud-footer">
    <div class="id" id="identity"></div>
    <div class="id" id="meta"></div>
  </div>
`;

export function mountHud(root = document.body) {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    document.head.appendChild(style);
  }
  const container = document.createElement('div');
  container.className = 'cdp-gpu-hud';
  container.innerHTML = MARKUP;
  root.appendChild(container);
  return container;
}
