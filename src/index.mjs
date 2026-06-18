// Programmatic entry point. Both the CLI and other tools can import this.
//
//   import { probeGpuMemory } from '@graysonlang/cdp-gpu-probe';
//   const report = await probeGpuMemory({ url: 'http://127.0.0.1:8080/webgl.html' });

import {
  CdpClient,
  disposeChrome,
  getBrowserWebSocketUrl,
  launchChrome,
  openInIsolatedChrome,
  parseDebugTarget,
  sleep,
  waitForPageTarget,
} from './cdp.mjs';
import { captureGpuMemory } from './memory-infra.mjs';
import { captureSystemInfo } from './system-info.mjs';
import { captureGpuHistograms, resetHistogramDelta } from './histograms.mjs';
import { streamGpuSamples } from './sample-stream.mjs';
import { startHudServer } from './hud-server.mjs';

// Poll the target until it responds (it may not be up yet), bailing on `signal` abort so
// a Ctrl-C during the wait stops promptly instead of hanging to the deadline. `onWaiting`
// fires once, the first time the server isn't reachable, so callers can explain the wait.
async function ensureServerReachable(url, timeoutMs, { signal, onWaiting } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let notified = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`Interrupted while waiting for ${url}.`);
    lastError = await reachabilityError(url, signal);
    if (!lastError) return;
    if (!notified) {
      notified = true;
      onWaiting?.(url);
    }
    await sleep(250);
  }
  throw new Error(`Could not reach ${url}. Start the dev server first.\n${lastError?.message || 'request failed'}`);
}

async function reachabilityError(url, signal) {
  let headError = null;
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (response.ok) return null;
    headError = new Error(`HEAD ${response.status} ${response.statusText}`);
  } catch (error) {
    headError = error;
  }

  try {
    const response = await fetch(url, { method: 'GET', signal });
    if (response.ok) return null;
    return new Error(`GET ${response.status} ${response.statusText}`);
  } catch (error) {
    return new Error(`${headError?.message || 'HEAD failed'}; GET failed: ${error.message}`);
  }
}

// Launch Chrome and run `work` with two CDP clients: `page` (a page target, for
// Page.navigate/Runtime) and `browser` (the browser-level endpoint, where global
// domains like SystemInfo and Browser live). The info/histograms probes need the
// browser client; navigation still goes through the page client.
async function withClients(options, work) {
  const { chrome, headed = false, timeoutMs = 20_000, userDataDir } = options;
  let session;
  let page;
  let browser;
  try {
    session = await launchChrome({ chrome, headed, userDataDir });
    const pageUrl = await waitForPageTarget(session.remotePort, timeoutMs);
    page = await CdpClient.connect(pageUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const browserUrl = await getBrowserWebSocketUrl(session.remotePort, timeoutMs);
    browser = await CdpClient.connect(browserUrl);
    return await work({ page, browser });
  } finally {
    page?.close();
    browser?.close();
    await disposeChrome(session);
  }
}

export async function probeGpuMemory(options = {}) {
  const {
    url,
    timeoutMs = 20_000,
    headed = false,
    chrome,
    levelOfDetail = 'detailed',
    samples = 1,
    intervalMs = 1000,
    settleMs = 1500,
    topTextures = 0,
    onSample = null,
    userDataDir,
  } = options;

  if (!url) throw new Error('probeGpuMemory requires a url.');
  await ensureServerReachable(url, timeoutMs);

  let session;
  let client;
  try {
    session = await launchChrome({ chrome, headed, userDataDir });
    const webSocketUrl = await waitForPageTarget(session.remotePort, timeoutMs);
    client = await CdpClient.connect(webSocketUrl);

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url });

    const report = await captureGpuMemory(client, {
      levelOfDetail,
      samples,
      intervalMs,
      settleMs,
      topTextures,
      onSample,
    });

    report.url = url;
    return report;
  } finally {
    client?.close();
    await disposeChrome(session);
  }
}

// Report GPU identity, driver, and feature/acceleration status. A url is optional:
// when given, the page is navigated first so feature status reflects a real GPU
// workload, but SystemInfo itself describes the launched Chrome instance.
export async function probeGpuInfo(options = {}) {
  const { url, timeoutMs = 20_000, settleMs = 0 } = options;
  return withClients(options, async ({ page, browser }) => {
    if (url) {
      await ensureServerReachable(url, timeoutMs);
      await page.send('Page.navigate', { url });
      if (settleMs > 0) await sleep(settleMs);
    }
    const info = await captureSystemInfo(browser);
    info.url = url ?? null;
    return info;
  });
}

// Report GPU-related UMA histograms (context losses, process lifetime, timing).
// With a url, the counts are deltas bracketed around the page's lifetime so a
// climbing context-loss/crash count is attributable to the page under test;
// without a url, they are absolute counts for the Chrome instance.
export async function probeGpuHistograms(options = {}) {
  const { url, timeoutMs = 20_000, settleMs = 1500, prefixes } = options;
  return withClients(options, async ({ page, browser }) => {
    const useDelta = Boolean(url);
    if (useDelta) {
      await resetHistogramDelta(browser);
      await ensureServerReachable(url, timeoutMs);
      await page.send('Page.navigate', { url });
      if (settleMs > 0) await sleep(settleMs);
    }
    const result = await captureGpuHistograms(browser, { prefixes, delta: useDelta });
    result.url = url ?? null;
    return result;
  });
}

// Live HUD: keep probing a page on an interval and stream each memory sample to a
// small local web dashboard over SSE. Long-running — resolves when stopped (Ctrl-C,
// the returned stop(), or an abort signal).
//
// Two targeting modes:
//   launch (default) — spawn an isolated headless Chrome and navigate it to `url`.
//   attach (`attach`) — bind to a Chrome already running with --remote-debugging-port.
//                       Measurement is whole-instance (the GPU process serves every tab),
//                       so attach drives the browser-level endpoint — no tab to pick,
//                       and never navigates/disposes (it's your browser).
export async function runHud(options = {}) {
  const {
    url,
    timeoutMs = 20_000,
    headed = false,
    chrome,
    levelOfDetail = 'detailed',
    intervalMs = 1000,
    settleMs = 1500,
    topTextures = 0,
    footprintIntervalMs = null,
    detailIntervalMs = null,
    port,
    open = true,
    signal,
    onReady = null,
    onWaiting = null,
    attach = null,
    userDataDir,
  } = options;

  const attaching = Boolean(attach);
  if (!attaching && !url) {
    throw new Error('runHud requires a url, or attach to bind to a running Chrome.');
  }
  if (!attaching) await ensureServerReachable(url, timeoutMs, { signal, onWaiting });

  let session;
  let page;
  let browser;
  let hud;
  let samples;
  let hudWindow;

  try {
    hud = await startHudServer({ port });

    // Get a CDP client to drive Tracing on. Attach uses the browser-level endpoint
    // (measurement is whole-instance, so there's no tab to pick); launch spawns Chrome
    // and uses a page target so it can navigate. `host` defaults to 127.0.0.1.
    let host = '127.0.0.1';
    let browserPort;
    let measured;
    if (attaching) {
      ({ host, port: browserPort } = parseDebugTarget(attach));
      const browserUrl = await getBrowserWebSocketUrl(browserPort, timeoutMs, host);
      page = await CdpClient.connect(browserUrl);
      measured = { mode: 'attached', title: null, url: `${host}:${browserPort}` };
    } else {
      session = await launchChrome({ chrome, headed, userDataDir });
      browserPort = session.remotePort;
      const webSocketUrl = await waitForPageTarget(browserPort, timeoutMs);
      page = await CdpClient.connect(webSocketUrl);
      measured = { mode: 'launched', title: null, url };
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Page.navigate', { url });
    }

    // One-time GPU identity for the HUD header (browser-level domain). In attach mode the
    // client already IS the browser endpoint; in launch mode open a side browser client.
    try {
      let infoClient = page;
      if (!attaching) {
        browser = await CdpClient.connect(await getBrowserWebSocketUrl(browserPort, timeoutMs, host));
        infoClient = browser;
      }
      hud.broadcast('info', await captureSystemInfo(infoClient));
    } catch {
      // identity is a nicety; the HUD still works on samples alone.
    }

    // Tell the HUD what it's bound to — the "am I measuring the right thing" signal.
    hud.broadcast('target', measured);

    // The interval loop is the transport-agnostic core; here we just pipe its
    // output to the HUD's SSE broadcast and let it abort on `signal` / stop().
    samples = streamGpuSamples(page, { levelOfDetail, intervalMs, settleMs, topTextures, footprintIntervalMs, detailIntervalMs, includeRaw: true, signal }, {
      onSample: sample => hud.broadcast('sample', sample),
      onError: error => hud.broadcast('status', { message: `sample skipped: ${error.message}` }),
    });

    // Open the HUD page in an ISOLATED Chrome window (own profile -> own GPU process), so
    // the dashboard's own rendering isn't charged to the GPU process we're measuring.
    // Closing that window stops sampling, so the CLI exits cleanly (mirrors cdp-gpu-hud).
    if (open) {
      hudWindow = openInIsolatedChrome(hud.url, { chrome });
      hudWindow.process.on('exit', () => samples.stop());
    }
    if (onReady) onReady({ hudUrl: hud.url, target: measured, intervalMs, stop: samples.stop });

    await samples.done;
  } finally {
    samples?.stop();
    page?.close();
    browser?.close();
    if (hudWindow) await hudWindow.dispose();
    if (hud) await hud.close();
    // Only tear down Chrome if we launched it — never kill the user's browser.
    if (session) await disposeChrome(session);
  }
}

export { streamGpuSamples } from './sample-stream.mjs';
// CDP transport + target discovery, so consumers can build their own launch glue
// (e.g. resolve a browser ws and open a direct HUD tab).
export {
  CdpClient,
  findChromePath,
  getBrowserWebSocketUrl,
  listPageTargets,
  selectPageTarget,
  openInIsolatedChrome,
  launchAppChrome,
  parseDebugTarget,
} from './cdp.mjs';
export { captureGpuMemory } from './memory-infra.mjs';
export { captureSystemInfo } from './system-info.mjs';
export { captureGpuHistograms } from './histograms.mjs';
export { humanBytes, formatReport, formatSystemInfo, formatHistograms } from './format.mjs';
