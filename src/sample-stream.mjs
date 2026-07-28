// Transport-agnostic live sampling loop.
//
// Given a connected CDP-like client, take one memory sample per interval and hand
// each to onSample. The client only needs the CdpClient surface (`send`/`on`), so
// the same loop drives the Node CLI (WebSocket transport) and, later, a
// chrome.debugger extension adapter — neither this file nor the capture/analysis
// layer it calls imports node:* or browser globals.
//
// Returns { stop, done }: call stop() (or abort the provided `signal`) to end the
// loop; `done` resolves once the loop has fully exited, so callers can tear down
// the transport without racing an in-flight capture.

import { captureGpuMemory } from './memory-infra.mjs';
import { sleep } from './util.mjs';

export function streamGpuSamples(client, options = {}, handlers = {}) {
  const {
    levelOfDetail = 'detailed',
    intervalMs = 1000,
    settleMs = 1500,
    topTextures = 0,
    includeRaw = false,
    // Two-rate sampling (opt-in): a fast `background` dump for the footprint interleaved
    // with a periodic `detailLevel` dump for the full rollups + per-resource data. Set both
    // to enable; leaving them null keeps the single-rate behavior (levelOfDetail/intervalMs).
    // Chrome tracing is global (one session at a time), so this is ONE serial loop that
    // varies the level, not two parallel loops. Each sample is tagged { ts, detailed }.
    footprintIntervalMs = null,
    detailIntervalMs = null,
    detailLevel = 'detailed',
    signal,
  } = options;
  const { onSample, onError } = handlers;
  const twoRate = footprintIntervalMs != null && detailIntervalMs != null;
  const tickMs = twoRate ? footprintIntervalMs : intervalMs;

  let stopped = false;
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });

  const stop = () => {
    stopped = true;
  };
  if (signal) signal.addEventListener('abort', stop, { once: true });

  (async function loop() {
    let firstSample = true;
    let lastDetailAt = 0; // 0 -> the first tick is a detailed one (so rollups appear at once)
    while (!stopped) {
      const detailed = twoRate ? Date.now() - lastDetailAt >= detailIntervalMs : true;
      const level = twoRate ? (detailed ? detailLevel : 'background') : levelOfDetail;
      try {
        const report = await captureGpuMemory(client, {
          levelOfDetail: level,
          samples: 1,
          settleMs: firstSample ? settleMs : 0,
          topTextures: detailed ? topTextures : 0,
          includeRaw: includeRaw && detailed,
        });
        firstSample = false;
        if (detailed) lastDetailAt = Date.now();
        const sample = report.samples[0];
        if (sample && onSample) {
          sample.ts = Date.now();
          sample.detailed = detailed;
          // The configured cadences, so the HUD can label the sections (footprint =
          // fast/tick cadence; detail = the slower one, equal to it in single-rate).
          sample.footprintIntervalMs = tickMs;
          sample.detailIntervalMs = twoRate ? detailIntervalMs : tickMs;
          if (!detailed) {
            // Footprint-only tick: drop background's coarse/incomplete rollups + resources
            // (e.g. it omits gpu/transfer_memory) so the HUD keeps its last detailed view.
            delete sample.rollups;
            delete sample.topTextures;
          }
          onSample(sample);
        }
      } catch (error) {
        if (onError) onError(error);
      }
      if (stopped) break;
      if (tickMs > 0) await sleep(tickMs);
    }
    resolveDone();
  })();

  return { stop, done };
}
