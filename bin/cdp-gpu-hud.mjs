#!/usr/bin/env node
// cdp-gpu-hud — open the direct GPU HUD in an ISOLATED Chrome window, with zero host
// wiring. It serves the HUD itself (the package's hud/ + src/ as native ESM, no bundler)
// and launches a separate Chrome (own profile = own GPU process, so the HUD's own
// rendering doesn't pollute the GPU you're measuring). The HUD reads the app's GPU stats
// over CDP from the app's Chrome (started elsewhere with --remote-debugging-port).
//
// Usage:
//   1. Launch the app's Chrome with the debug port AND allow this HUD's origin:
//        chrome --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9292
//      (a dev harness like esp does this via --debug-port; for the flag, see below.)
//   2. cdp-gpu-hud [--attach=9222] [--hud-port=9292] [--text]
//
// The HUD auto-re-attaches: if the app's Chrome restarts (new debug session), the HUD
// re-resolves the ws through this server's /ws endpoint and resumes. Close the HUD window
// (or Ctrl-C) to stop — the server lifecycle is bound to the HUD window, not your dev server.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserWebSocketUrl, launchAppChrome, openInIsolatedChrome, parseDebugTarget } from '../src/index.mjs';

const PKG_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVE_DIRS = new Set(['hud', 'src']); // the direct HUD's native-ESM module graph
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args.set(match[1], match[2] ?? true);
}
if (args.has('help')) {
  process.stdout.write(`Usage: cdp-gpu-hud [--attach=<port|host:port>] [--hud-port=<n>] [--text] [--chrome=<path>]

Opens the direct GPU HUD in an isolated Chrome window and serves it from this package.
The app's Chrome must run with --remote-debugging-port and allow this HUD's origin, e.g.:
  chrome --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9292
Or skip that wiring entirely and let this launch the app's Chrome for you:
  cdp-gpu-hud --launch-app=http://localhost:4200

  --attach=<port>   App's debug port (or host:port). Default 9222.
  --launch-app=<url>  Also launch the app's Chrome at <url> on the attach port, with a
                      persistent profile and the correct --remote-allow-origins set
                      automatically (no hardcoded Chrome path or temp dir needed).
  --hud-port=<n>    Port this serves the HUD on. Default 9292.
  --text            Start with no charts ticked (lightest; tick rows to add charts).
  --footprint-interval=<ms>  Two-rate: fast footprint cadence (needs --detail-interval).
  --detail-interval=<ms>     Two-rate: periodic full-detail cadence.
  --chrome=<path>   Chrome binary (else CDP_GPU_PROBE_CHROME / CHROME_PATH).
`);
  process.exit(0);
}

const { host, port: appPort } = parseDebugTarget(args.get('attach') || '9222');
const hudPort = Number(args.get('hud-port') || 9292);
const wantText = args.has('text');
const chromeOverride = args.get('chrome') ? String(args.get('chrome')) : undefined;
const launchAppUrl = typeof args.get('launch-app') === 'string' ? String(args.get('launch-app')) : undefined;

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // Same-origin discovery: resolve the app Chrome's current browser ws (re-resolvable
  // across app restarts; Node has no CORS limit on /json). 503 while the app is down.
  if (urlPath === '/ws') {
    try {
      const ws = await getBrowserWebSocketUrl(appPort, 1500, host);
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.json'] })
        .end(JSON.stringify({ ws, label: `${host}:${appPort}` }));
    } catch {
      res.writeHead(503).end('app debug endpoint not reachable');
    }
    return;
  }

  // Static: serve the HUD's module graph from hud/ and src/ (path-traversal guarded).
  const rel = urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PKG_ROOT, rel);
  const inside = filePath === PKG_ROOT || filePath.startsWith(PKG_ROOT + path.sep);
  if (!SERVE_DIRS.has(rel.split('/')[0]) || !inside) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(hudPort, '127.0.0.1', resolve);
});

// Optionally launch the app's Chrome ourselves, on the same port the HUD attaches to and
// allowing this server's origin — so the two values that must agree can't drift. The HUD
// auto-attaches via /ws once it answers, so launch order vs. the HUD window doesn't matter.
const appWindow = launchAppUrl
  ? launchAppChrome(launchAppUrl, {
      chrome: chromeOverride,
      port: appPort,
      allowOrigin: `http://127.0.0.1:${hudPort}`,
    })
  : null;
if (appWindow) process.stdout.write(`App Chrome launched → ${launchAppUrl} (debug port ${appPort})\n`);

// The page defaults to discovering its ws via the same-origin /ws endpoint (below), so no
// ?discover= is needed; it re-resolves there on disconnect for auto re-attach.
const hudUrl = new URL(`http://127.0.0.1:${hudPort}/hud/direct.html`);
if (wantText) hudUrl.searchParams.set('text', '');
for (const flag of ['footprint-interval', 'detail-interval']) {
  if (args.get(flag)) hudUrl.searchParams.set(flag, String(args.get(flag)));
}

// Isolated Chrome: a fresh per-run profile = a fresh process tree and its own GPU process,
// so the HUD's rendering isn't charged to the app's GPU process. (Shared with the CLI SSE
// HUD via openInIsolatedChrome — one source for "open a HUD in an isolated window".)
const hudWindow = openInIsolatedChrome(hudUrl, { chrome: chromeOverride });

process.stdout.write(`GPU HUD window opened (isolated Chrome) → ${hudUrl}\n`);
if (!appWindow) {
  process.stdout.write(`Allow it: start the app's Chrome with --remote-allow-origins=http://127.0.0.1:${hudPort}\n`);
}
process.stdout.write(`Measuring Chrome @ ${host}:${appPort} — close the HUD window (or Ctrl-C) to stop.\n`);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise(resolve => server.close(resolve));
  await hudWindow.dispose(); // kills the isolated Chrome and reaps its profile
  if (appWindow) await appWindow.dispose(); // kill the app Chrome we launched (profile persists)
  process.exit(code);
}
hudWindow.process.on('exit', () => shutdown(0)); // closing the HUD window stops the server
hudWindow.process.on('error', () => shutdown(1));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
