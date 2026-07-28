// Direct HUD: the dashboard talks CDP directly, with no Node bridge process. ("Direct"
// because the browser page IS the CDP client — vs the SSE HUD, where Node holds the CDP
// connection and relays samples to a passive page. Both render in the browser; the
// difference is which side speaks the protocol.)
//
// It connects a CdpClient straight to a page target's webSocketDebuggerUrl and runs
// the same node-free core (streamGpuSamples → memory-infra parser) and renderer the
// CLI uses. Intended for local dev: import it into your app's dev build (esbuild et al.)
// and mount it, or open the bundled page with ?ws=<encoded webSocketDebuggerUrl>.
//
// Two launch requirements (see README "direct mode"):
//   1. Chrome must run with --remote-allow-origins=<this page's origin> (or *), or the
//      browser's WebSocket handshake to the CDP endpoint is rejected with 403.
//   2. The page can't discover the ws itself (the /json endpoints aren't CORS-enabled),
//      so it fetches a SAME-ORIGIN endpoint that resolves it — `/ws` by default (served by
//      the cdp-gpu-hud bin). Or hand it a ws directly via { ws } / window.__GPU_WS__ / ?ws=.
//
//   import { startDirectHud } from '@graysonlang/cdp-gpu-probe/direct';
//   const hud = await startDirectHud();            // discovers via /ws, or { ws } / ?ws=
//   // …later: hud.stop();

import { CdpClient } from '../src/cdp-client.mjs';
import { streamGpuSamples } from '../src/sample-stream.mjs';
import { captureSystemInfo } from '../src/system-info.mjs';
import { humanBytes } from '../src/format.mjs';
import { mountHud } from './hud-dom.js';
import { createHudRenderer } from './hud-render.js';

// Console-only sink: a blank page that just logs each sample. Useful as a control to
// see how much GPU the HUD's own DOM/canvas rendering costs (open with ?console).
function consoleSink() {
  const prev = new Map();
  const line = (key, value) => {
    const last = prev.get(key);
    prev.set(key, value);
    const d =
      last === undefined
        ? ''
        : value > last
          ? ` ▲${humanBytes(value - last)}`
          : value < last
            ? ` ▼${humanBytes(last - value)}`
            : ' ·';
    return `${key} ${humanBytes(value)}${d}`;
  };
  return {
    renderTarget: t => console.log(`[gpu] target: ${[t.title, t.url].filter(Boolean).join(' · ')}`),
    renderInfo: info =>
      console.log(`[gpu] ${[info.modelName, info.gl?.renderer].filter(Boolean).join(' · ')}`),
    setLive: () => {},
    renderSample: sample => {
      const parts = Object.entries(sample.rollups || {})
        .filter(([k]) => k !== 'gpu/gl')
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => line(k, v));
      console.log(`[gpu] ${new Date().toLocaleTimeString()}  ${parts.join('  |  ')}`);
    },
    setStatus: msg => console.warn(`[gpu] ${msg}`),
    redraw: () => {},
  };
}

// Rebuild a CDP ws URL from decomposed query params — `?port=9222&id=<uuid>` — so a
// hand-written URL needs no percent-encoding. Defaults: 127.0.0.1, the browser endpoint.
function wsFromParams(params) {
  const id = params.get('id');
  if (!id) return null;
  const host = params.get('host') || '127.0.0.1';
  const port = params.get('port') || '9222';
  const kind = params.get('target') || 'browser'; // browser | page
  return `ws://${host}:${port}/devtools/${kind}/${id}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Parse a numeric query param, or null when absent/blank/non-numeric.
function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function startDirectHud(options = {}) {
  const params = new URLSearchParams(globalThis.location?.search);
  const {
    ws: wsOption,
    browserWs = null, // optional browser-target ws for GPU identity (SystemInfo)
    label = null,
    root = document.body,
    intervalMs = 1000,
    settleMs = 1500,
    levelOfDetail = 'detailed',
    topTextures = 0,
    // Two-rate sampling (opt-in): ?footprint-interval=&detail-interval= or { ... }.
    footprintIntervalMs = numOrNull(params.get('footprint-interval')),
    detailIntervalMs = numOrNull(params.get('detail-interval')),
    signal,
    consoleOnly = params.has('console'),
    textOnly = params.has('text'),
    discover: discoverOption,
  } = options;

  // A one-shot ws you can hand the page directly: { ws }, the opener-injected
  // window.__GPU_WS__ (clean URL), ?ws=<full url>, or the decomposed ?port=&id= form.
  const staticWs = wsOption ?? globalThis.__GPU_WS__ ?? params.get('ws') ?? wsFromParams(params);

  // A SAME-ORIGIN endpoint returning { ws, label } that the HUD re-resolves through to
  // re-attach after the app's Chrome restarts (the page can't re-resolve itself — /json
  // isn't CORS-enabled — but a same-origin server like the cdp-gpu-hud bin can). Defaults
  // to /ws when no ws was handed in directly, so the bin-served page needs no ?discover=
  // in its URL; an explicit ?discover= / { discover } or a direct ws overrides, and
  // { discover: false } opts out. A reload re-resolves through /ws, so no ws persistence.
  const discover = discoverOption ?? params.get('discover') ?? (staticWs ? null : '/ws');

  if (!discover && !staticWs) {
    throw new Error('startDirectHud needs a ws (pass { ws } / ?ws=…) or a { discover } endpoint.');
  }

  // One HUD; ?text just starts with no charts ticked (pure tables, no GPU-backed canvases
  // until you tick a row). ?console is the blank-page control (devtools logs only). Both
  // isolate the HUD's own rendering cost from the GPU it measures.
  const hud = consoleOnly
    ? consoleSink()
    : createHudRenderer(mountHud(root), { charts: !textOnly });

  let stopped = false;
  let client = null;
  let samples = null;

  // Resolve the app's browser ws — re-resolvable via the discover endpoint, else the
  // one-shot static ws.
  async function resolveTarget() {
    if (!discover) return { ws: staticWs, label: label || staticWs };
    const res = await fetch(discover, { cache: 'no-store' });
    if (!res.ok) throw new Error(`discover ${res.status}`);
    const data = await res.json();
    if (!data.ws) throw new Error('discover returned no ws');
    return { ws: data.ws, label: label || data.label || data.ws };
  }

  async function attach() {
    const target = await resolveTarget();
    client = await CdpClient.connect(target.ws);
    hud.renderTarget({ mode: 'attached', title: null, url: target.label });
    hud.setLive(true);
    hud.setStatus('');

    // GPU identity is best-effort (browser endpoint answers SystemInfo).
    try {
      const infoClient = browserWs ? await CdpClient.connect(browserWs) : client;
      hud.renderInfo(await captureSystemInfo(infoClient));
      if (browserWs) infoClient.close();
    } catch {
      // identity is a nicety; the HUD still works on samples alone.
    }

    samples = streamGpuSamples(
      client,
      {
        levelOfDetail,
        intervalMs,
        settleMs,
        topTextures,
        footprintIntervalMs,
        detailIntervalMs,
        includeRaw: true,
        signal,
      },
      {
        onSample: sample => hud.renderSample(sample),
        onError: error => hud.setStatus(`sample skipped: ${error.message}`),
      },
    );

    const onDrop = () => {
      if (stopped) return;
      hud.setLive(false);
      samples?.stop();
      if (discover) reconnect();
      else hud.setStatus('disconnected — relaunch the app and reload to re-attach');
    };
    client.webSocket.addEventListener('close', onDrop, { once: true });
    client.webSocket.addEventListener('error', onDrop, { once: true });
  }

  // Poll the discover endpoint until the app's Chrome is back, then re-attach.
  async function reconnect() {
    hud.setStatus('app disconnected — waiting to re-attach…');
    while (!stopped) {
      await sleep(1000);
      try {
        await attach();
        return;
      } catch {
        // app still down; keep polling
      }
    }
  }

  // Initial attach: with a discover endpoint, tolerate the app not being up yet.
  try {
    await attach();
  } catch (error) {
    if (!discover) throw error;
    reconnect();
  }

  globalThis.addEventListener?.('resize', () => hud.redraw());
  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        stopped = true;
        samples?.stop();
        client?.close();
      },
      { once: true },
    );
  }

  return {
    stop: () => {
      stopped = true;
      samples?.stop();
      client?.close();
    },
  };
}

export default startDirectHud;
