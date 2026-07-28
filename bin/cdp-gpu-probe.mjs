#!/usr/bin/env node
// cdp-gpu-probe — report GPU information for a page over the Chrome DevTools Protocol.
//
// Subcommands:
//   memory      GPU process memory (textures/buffers/total) with a leak delta. [default]
//   info        GPU identity, driver, and feature/acceleration status (SystemInfo).
//   histograms  GPU stability/timing histograms — context losses, crashes, lifetime.
//
// Generic on purpose: point it at any URL. It launches an isolated headless Chrome
// and reads Chrome's own GPU accounting — no Puppeteer, no app changes required.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { probeGpuMemory, probeGpuInfo, probeGpuHistograms, runHud } from '../src/index.mjs';
import { formatReport, formatSystemInfo, formatHistograms } from '../src/format.mjs';

const COMMANDS = new Set(['memory', 'info', 'histograms', 'hud']);

const argv = process.argv.slice(2);
let command = 'memory';
if (argv[0] && !argv[0].startsWith('--') && COMMANDS.has(argv[0])) {
  command = argv.shift();
}

const args = new Map();
for (const arg of argv) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args.set(match[1], match[2] ?? true);
}

// Default page to measure when --url is omitted (memory + hud launch mode). localhost,
// not 127.0.0.1, so it matches how dev servers are usually addressed in the browser.
const DEFAULT_URL = 'http://localhost:8000';

const HELP = `Usage: cdp-gpu-probe <command> [--url=<url>] [options]

Commands:
  memory      GPU process memory with a leak delta (default).
  info        GPU identity, driver, and feature/acceleration status.
  histograms  GPU stability/timing histograms (context loss, crashes, lifetime).
  hud         Live web dashboard streaming GPU memory while you interact with the page.

Common options:
  --url=<url>            Page to probe (memory/hud default ${DEFAULT_URL}; optional for info/histograms).
  --headed               Show the browser window.
  --chrome=<path>        Chrome binary (else CDP_GPU_PROBE_CHROME / CHROME_PATH).
  --user-data-dir=<path> Launch mode: reuse this Chrome profile instead of a throwaway
                          one (left in place on exit). Ignored when attaching.
  --timeout=<ms>         Server reachability + target wait (default 20000).
  --json                 Print machine-readable JSON instead of a table.
  --out=<path>           Also write the JSON report to a file.
  --label=<text>         Label shown in the report header.

memory options:
  --samples=<n>          Number of memory dumps to take (default 1).
  --interval=<ms>        Delay between samples (default 1000).
  --settle=<ms>          Wait before the first sample (default 1500).
  --level=<detail>       background | light | detailed (default detailed).
  --top=<n>              Show the n largest individual GPU resources (GL textures,
                          macOS shared images, Dawn textures).

info options:
  --settle=<ms>          With --url, wait after navigation before reading (default 0).

histograms options:
  --settle=<ms>          With --url, wait after navigation before reading (default 1500).
  --prefixes=<a,b,...>   Histogram name prefixes to query (default GPU.,Memory.GPU.,Compositing.,Graphics.).
  --all                  Show every matched histogram, not just health signals.

hud options (long-running — Ctrl-C to stop):
  --url=<url>            Page to load in a fresh headless Chrome (launch mode; default ${DEFAULT_URL}).
  --attach=<port>       Bind to a Chrome already running with --remote-debugging-port
                          (e.g. --attach=9222). Accepts a port or host:port. Measures the
                          whole browser instance. Mutually exclusive with --url.
  --interval=<ms>        Delay between samples (default 1000). Single-rate.
  --footprint-interval=<ms>  Two-rate: fast cadence for the footprint (cheap background
                          dump). Requires --detail-interval. Default 250 when set.
  --detail-interval=<ms> Two-rate: periodic cadence for the full rollups + per-resource
                          (detailed dump). Requires --footprint-interval. Default 2000.
  --settle=<ms>          Wait before the first sample (default 1500).
  --port=<n>             HUD server port (default: an open port).
  --no-open              Do not auto-open the HUD window (an isolated Chrome).
  --level=<detail>       background | light | detailed (default detailed).
  --top=<n>              Also stream the n largest individual GPU resources (GL textures,
                          macOS shared images, Dawn textures).

Launch mode (default) measures an isolated headless Chrome — start the dev server
first, e.g.:  npm run serve -- --port=8080

Attach mode measures YOUR browser (the GPU process serves every tab, so the numbers are
whole-instance). Launch it with a dedicated profile running just the app under test:
  chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
  cdp-gpu-probe hud --attach=9222`;

if (args.has('help')) {
  console.log(HELP);
  process.exit(0);
}

const numeric = (key, fallback, rules = {}) => {
  const value = args.get(key);
  if (value === undefined) return fallback;
  const text = String(value).trim();
  if (value === true || text === '') {
    throw new Error(`--${key} requires a numeric value.`);
  }
  const parsed = Number(text);
  const { integer = false, min = -Infinity, max = Infinity } = rules;
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < min ||
    parsed > max
  ) {
    const range =
      Number.isFinite(min) || Number.isFinite(max)
        ? ` between ${Number.isFinite(min) ? min : '-Infinity'} and ${Number.isFinite(max) ? max : 'Infinity'}`
        : '';
    throw new Error(`--${key} must be a ${integer ? 'whole ' : ''}number${range}.`);
  }
  return parsed;
};
const string = key => (args.get(key) ? String(args.get(key)) : undefined);
const label = string('label');

function commonOptions() {
  return {
    url: string('url'),
    headed: args.has('headed'),
    chrome: string('chrome'),
    timeoutMs: numeric('timeout', 20_000, { integer: true, min: 1 }),
    userDataDir: string('user-data-dir'),
  };
}

async function writeOut(report) {
  if (!args.has('out')) return;
  const outPath = path.resolve(String(args.get('out')));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
  process.stderr.write(`  wrote ${path.relative(process.cwd(), outPath)}\n`);
}

async function runMemory() {
  const report = await probeGpuMemory({
    ...commonOptions(),
    url: string('url') || DEFAULT_URL,
    samples: numeric('samples', 1, { integer: true, min: 1 }),
    intervalMs: numeric('interval', 1000, { integer: true, min: 0 }),
    settleMs: numeric('settle', 1500, { integer: true, min: 0 }),
    levelOfDetail: string('level') || 'detailed',
    topTextures: numeric('top', 0, { integer: true, min: 0 }),
    onSample: total => process.stderr.write(`  captured sample ${total}\n`),
  });
  await writeOut(report);
  return args.has('json') ? JSON.stringify(report, null, 2) : formatReport(report, { label });
}

async function runInfo() {
  const report = await probeGpuInfo({
    ...commonOptions(),
    settleMs: numeric('settle', 0, { integer: true, min: 0 }),
  });
  await writeOut(report);
  return args.has('json') ? JSON.stringify(report, null, 2) : formatSystemInfo(report, { label });
}

async function runHistograms() {
  const report = await probeGpuHistograms({
    ...commonOptions(),
    settleMs: numeric('settle', 1500, { integer: true, min: 0 }),
    prefixes: args.has('prefixes')
      ? String(args.get('prefixes'))
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : undefined,
  });
  await writeOut(report);
  return args.has('json')
    ? JSON.stringify(report, null, 2)
    : formatHistograms(report, { label, all: args.has('all') });
}

async function runHudCmd() {
  // Attach binds to a running Chrome (url ignored); otherwise launch mode defaults the url.
  const attaching = args.has('attach');
  const launchUrl = string('url') || (attaching ? undefined : DEFAULT_URL);

  if (!attaching) {
    process.stderr.write(
      `  launch mode: starting a hidden headless Chrome at ${launchUrl} to probe its GPU memory.\n`,
    );
    process.stderr.write(
      '  (you measure that off-screen page; the window that opens is the HUD dashboard, not the page itself.)\n',
    );
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    controller.abort();
    // A second Ctrl-C forces exit, in case something downstream isn't watching the signal.
    if (++interrupts >= 2) process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    await runHud({
      ...commonOptions(),
      url: launchUrl,
      attach: string('attach'),
      intervalMs: numeric('interval', 1000, { integer: true, min: 0 }),
      settleMs: numeric('settle', 1500, { integer: true, min: 0 }),
      levelOfDetail: string('level') || 'detailed',
      topTextures: numeric('top', 0, { integer: true, min: 0 }),
      // Two-rate sampling: fast footprint + periodic detailed (both required to enable).
      footprintIntervalMs: args.has('footprint-interval')
        ? numeric('footprint-interval', 250, { integer: true, min: 0 })
        : null,
      detailIntervalMs: args.has('detail-interval')
        ? numeric('detail-interval', 2000, { integer: true, min: 0 })
        : null,
      port: args.has('port')
        ? numeric('port', undefined, { integer: true, min: 0, max: 65535 })
        : undefined,
      open: !args.has('no-open'),
      signal: controller.signal,
      onWaiting: url =>
        process.stderr.write(
          `  waiting for ${url} to respond — start your dev server (Ctrl-C to stop)\n`,
        ),
      onReady: ({ hudUrl, target, intervalMs }) => {
        const what =
          target.mode === 'attached' ? `attached to ${target.url}` : `probing ${target.url}`;
        process.stderr.write(`  HUD:   ${hudUrl}\n`);
        process.stderr.write(`  ${what} every ${intervalMs}ms — Ctrl-C to stop\n`);
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return 'HUD stopped.';
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
  return 'HUD stopped.';
}

const runners = { memory: runMemory, info: runInfo, histograms: runHistograms, hud: runHudCmd };

runners[command]()
  .then(output => console.log(output))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
