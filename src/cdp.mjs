// Minimal Chrome DevTools Protocol client and launcher.
//
// Intentionally dependency-free: it speaks CDP over the global WebSocket that
// modern Node ships. Nothing in here is project specific, so it can be shared
// across repos.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { sleep } from './util.mjs';

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// Resolve a Chrome/Chromium binary. Honors an explicit override first, then a
// couple of generic env vars, then the usual install locations on macOS and Linux.
export function findChromePath(explicit) {
  const candidates = [
    explicit,
    process.env.CDP_GPU_PROBE_CHROME,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  const chromePath = candidates.find(candidate => existsSync(candidate));
  if (!chromePath) {
    throw new Error('Could not find Chrome. Set CDP_GPU_PROBE_CHROME or pass --chrome=/path/to/chrome.');
  }
  return chromePath;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

// Launch an isolated headless Chrome with a remote debugging port. By default a
// throwaway user-data-dir keeps the GPU process clean so memory-infra dumps reflect
// the page under test rather than leftover tabs. Pass `userDataDir` to reuse a
// specific profile instead — it is then treated as the caller's and left in place on
// teardown (only auto-generated profiles are removed).
export async function launchChrome(options = {}) {
  const {
    chrome: chromeOverride,
    headed = false,
    windowSize = '1280,720',
    extraArgs = [],
    userDataDir: userDataDirOverride,
  } = options;

  const chromePath = findChromePath(chromeOverride);
  const remotePort = await getFreePort();
  const ephemeralProfile = !userDataDirOverride;
  const userDataDir = userDataDirOverride
    || path.join(os.tmpdir(), `cdp-gpu-probe-${process.pid}-${Date.now()}`);
  const chromeArgs = [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-default-browser-check',
    '--no-first-run',
    `--window-size=${windowSize}`,
    // Keep WebGL/WebGPU alive in headless on machines without a real GPU.
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--enable-unsafe-webgpu',
    ...extraArgs,
  ];

  if (!headed) chromeArgs.push('--headless=new');
  chromeArgs.push('about:blank');

  const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  chrome.stderr.on('data', chunk => stderr.push(String(chunk)));

  return { chrome, remotePort, stderr, userDataDir, ephemeralProfile };
}

// The browser-level debugging endpoint. Global domains like SystemInfo and
// Browser are only served here, not on a page target's connection.
export async function getBrowserWebSocketUrl(remotePort, timeoutMs = 20_000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://${host}:${remotePort}/json/version`);
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the Chrome browser-level DevTools endpoint.');
}

// Parse a --attach value into { host, port }. Accepts "9222", "host:9222", or a
// full "http://host:9222" — the forms a user is likely to paste.
export function parseDebugTarget(attach) {
  const cleaned = String(attach).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const match = cleaned.match(/^(?:(.+):)?(\d{2,5})$/);
  if (!match) {
    throw new Error(`Invalid --attach value "${attach}". Use a port (e.g. 9222) or host:port.`);
  }
  return { host: match[1] || '127.0.0.1', port: Number(match[2]) };
}

// List the page (tab) targets of an already-running Chrome started with
// --remote-debugging-port. Retries briefly so it tolerates a just-launched Chrome,
// but fails with an actionable message if the endpoint never answers.
export async function listPageTargets(host, port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://${host}:${port}/json/list`);
      return targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(
    `Could not reach a Chrome remote-debugging endpoint at ${host}:${port}. `
    + `Launch Chrome with --remote-debugging-port=${port} (and a dedicated --user-data-dir).\n`
    + (lastError?.message || 'request failed'),
  );
}

// Choose one page target. With no matcher, require exactly one tab (otherwise list
// them so the caller can disambiguate). With a matcher, substring-match title/url.
// Either way the rejection lists what's open — the "am I measuring the right thing"
// reinforcement starts here.
export function selectPageTarget(targets, matcher) {
  const describe = list => list.map(t => `  • ${t.title || '(untitled)'} — ${t.url}`).join('\n');

  if (targets.length === 0) {
    throw new Error('No page targets found. Open the page you want to measure in a tab first.');
  }
  if (!matcher) {
    if (targets.length === 1) return targets[0];
    throw new Error(`Multiple tabs are open; pass --target=<substring of title or url>:\n${describe(targets)}`);
  }
  const needle = String(matcher).toLowerCase();
  const matches = targets.filter(t =>
    (t.title || '').toLowerCase().includes(needle) || (t.url || '').toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(`No tab matched --target="${matcher}". Open tabs:\n${describe(targets)}`);
  }
  return matches[0];
}

export async function waitForPageTarget(remotePort, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`);
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome DevTools page target.');
}

// The CDP client lives in its own node-free module so the direct HUD can import it
// without dragging this file's node:* dependencies into a browser bundle.
export { CdpClient } from './cdp-client.mjs';

// Open a URL in the user's default browser. Best-effort: a failure to launch the
// browser should never take down the HUD, so this swallows errors. Detached so the
// spawned launcher doesn't keep the Node process alive.
export function openInBrowser(url) {
  const platform = process.platform;
  const [command, args]
    = platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser launcher available; the URL was already printed for manual use.
  }
}

// Open a URL in an ISOLATED Chrome window: a throwaway profile, so the window gets its
// OWN GPU process — a HUD can then display live numbers without charging its own
// rendering to the GPU process it's measuring (the observer effect). A normal
// --new-window (not --app): on macOS an --app window reopens as a *new* window when you
// click the dock icon instead of fronting the existing one. Returns the child plus a
// dispose() that kills it and reaps the profile; the caller binds lifecycle (e.g. close
// window -> stop sampling).
export function openInIsolatedChrome(url, options = {}) {
  const { chrome: chromeOverride, windowSize = '480,760' } = options;
  const chromePath = findChromePath(chromeOverride);
  const userDataDir = path.join(os.tmpdir(), `cdp-gpu-hud-${process.pid}-${Date.now()}`);
  const child = spawn(chromePath, [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    String(url), // spawn args must be strings; callers may pass a URL object
  ], { stdio: 'ignore' });
  child.on('error', () => {}); // keep an unhandled 'error' from throwing; callers may add their own

  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      child.kill();
    } catch {
      // already gone
    }
    await sleep(50);
    await rm(userDataDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }

  return { process: child, userDataDir, dispose };
}

// Convenience teardown mirroring the verifier's finally block. Profile-dir
// removal is best-effort: Chrome may still be flushing files for a moment after
// kill (ENOTEMPTY/EBUSY), and a leftover temp dir is harmless — never let cleanup
// failure mask the probe's result by throwing out of a finally block.
export async function disposeChrome(session) {
  if (!session) return;
  try {
    session.chrome.kill();
  } catch {
    // already gone
  }
  await sleep(50);
  // Only remove a profile we generated; never delete a caller-supplied one.
  if (session.ephemeralProfile === false) return;
  try {
    await rm(session.userDataDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // leave the temp dir for the OS to reap.
  }
}

export { sleep };
