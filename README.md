# @graysonlang/cdp-gpu-probe

Report **GPU resource info** (WebGL/WebGPU textures and buffers) for a running
page, from the command line. Useful for catching texture/ImageBitmap leaks that
the DevTools Memory panel can't see, because GPU resources live in Chrome's
**GPU process**, not in the renderer's JS heap.

The headline number is the GPU process's **authoritative OS-level footprint**
(`private_footprint`, the same metric class as iOS jetsam) — a real external
measurement, not the app's own bookkeeping. See [How it measures](#how-it-measures).

It is deliberately generic — point it at any URL — and dependency-free on the
Node side: it drives Chrome over the DevTools Protocol using the global
`WebSocket` in Node 22+. No Puppeteer.

## Try it (bundled example)

This repo ships a scratch WebGL/WebGPU harness under [`example/`](example/) that
allocates real textures from ImageBitmaps (plus WebGPU textures and a buffer) so
you can watch the probe respond.

```sh
npm install
npm run dev            # serves example/ on :8000 and launches a dev Chrome (debug port 9222)
# in another shell:
npm run probe:watch    # 12 snapshots in a fresh headless Chrome
npm run probe:hud      # or: live dashboard, attached to the dev Chrome you're clicking in
```

The page has buttons to add/free WebGL and WebGPU resources and a **Leak** toggle.
Loading `http://localhost:8000/?leak` auto-starts the leak so a headless probe run
sees a climbing footprint with no clicks.

## Install

Install straight from GitHub — no npm registry publish required:

```jsonc
// package.json of the consuming project
"devDependencies": {
  "@graysonlang/cdp-gpu-probe": "github:graysonlang/cdp-gpu-probe"
}
```

For local development against a sibling checkout (preferred over global `npm link`):

```sh
cd ../your-app
npm install --no-save ../cdp-gpu-probe
```

## How it measures

Two numbers come from a single memory-infra trace:

1. **GPU process footprint — authoritative (the headline).** The kernel-reported
   `private_footprint` of the GPU process — a real OS-level measurement that tracks
   GPU memory across every backend, **including WebGPU/Dawn on Metal** where Chrome's
   own allocator breakdown does not. It's per-process (the GPU process serves every
   tab), so measure a dedicated profile for per-app numbers.
2. **Allocator breakdown — Chrome's self-report (secondary).** The `gpu/*` memory-infra
   nodes, surfaced so you can see *where* memory sits. Reliable on SwiftShader/Linux and
   for macOS WebGL, but incomplete for WebGPU/Dawn on Metal — treat it as a *where-ish*
   hint, not the total.

> On macOS Metal/ANGLE the allocator breakdown is partial — read the **footprint**
> column, and use `--json` for the raw keys.

Full methodology, the per-backend node mapping, and the verification details are in
[TECHNICAL.md](TECHNICAL.md#how-it-measures).

## CLI

Four subcommands, all driving the same isolated headless Chrome over CDP:

| Command | What it reports | Source |
| --- | --- | --- |
| `memory` (default) | GPU process texture/buffer/total footprint with a leak delta | memory-infra trace |
| `info` | GPU identity, driver, and feature/acceleration status | `SystemInfo.getInfo` |
| `histograms` | Stability/timing signals — context losses, crashes, GPU process lifetime | `Browser.getHistograms` |
| `hud` | Live web dashboard streaming the `memory` numbers as you interact | memory-infra trace + SSE |

`memory` and `hud` require `--url`; `info` and `histograms` take it optionally.

### `memory` (default)

```sh
# single snapshot (the bare command defaults to `memory`)
npx cdp-gpu-probe --url=http://127.0.0.1:8080/webgl.html

# leak watch: 12 dumps, 1s apart, with the 10 biggest textures
npx cdp-gpu-probe memory --url=http://127.0.0.1:8080/webgl.html --samples=12 --interval=1000 --top=10
```

```
#        gpu total       Δ total      textures     buffers
----------------------------------------------------------
1         50.0 MiB             -      32.0 MiB    8.00 MiB
2         74.0 MiB     +24.0 MiB      56.0 MiB    8.00 MiB
3         98.0 MiB     +48.0 MiB      80.0 MiB    8.00 MiB
```

A steadily climbing `Δ total` / `textures` column across samples while the scene
is static is the leak signal.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url=<url>` | — | Page to probe (required) |
| `--samples=<n>` | `1` | Number of memory dumps |
| `--interval=<ms>` | `1000` | Delay between samples |
| `--settle=<ms>` | `1500` | Wait before the first sample |
| `--level=<detail>` | `detailed` | `background` \| `light` \| `detailed` |
| `--top=<n>` | `0` | Show the n largest individual GPU resources — GL textures, macOS shared images, Dawn textures (needs `detailed`) |

### `info` — GPU capabilities

The structured form of `chrome://gpu`: device/driver identity, the GL/ANGLE
backend, per-pipeline feature status (`webgl`, `webgpu`, `gpu_compositing`,
`video_decode`, …), active driver bug workarounds, and hardware video codec
support. No tracing, and `--url` is optional — `SystemInfo` describes the launched
Chrome instance, so this also explains *why* the `memory` numbers look as they do
(e.g. WebGL reported as `enabled` vs software).

```sh
npx cdp-gpu-probe info            # capabilities of the probe's Chrome
npx cdp-gpu-probe info --json     # same, machine-readable
```

`info` options: `--url` (optional; navigates first), `--settle=<ms>` (default 0).

### `histograms` — stability & timing

Reads GPU-related UMA histograms (`Browser.getHistograms`): GPU process lifetime,
context losses, crashes, blocklist results, and draw/swap timing. With `--url` the
counts are **deltas bracketed around the page's lifetime**, so a climbing
context-loss / crash count is attributable to the page under test; without a URL
they are absolute counts since launch. The formatted view promotes health signals
(loss/crash/error/lifetime); `--all` or `--json` shows every matched histogram.

```sh
npx cdp-gpu-probe histograms --url=http://127.0.0.1:8080/webgl.html
npx cdp-gpu-probe histograms --url=http://127.0.0.1:8080/webgl.html --all
```

`histograms` options: `--url` (optional), `--settle=<ms>` (default 1500),
`--prefixes=<a,b,...>` (default `GPU.,Memory.GPU.,Compositing.,Graphics.`), `--all`.

### `hud` — live dashboard

A long-running companion to `memory`: instead of one snapshot, it keeps probing a
page on an interval and streams each sample to a small local web page — numeric tiles
with delta-from-baseline plus rolling sparklines for GPU total / textures / buffers,
under a one-time GPU-identity header. It's the interactive way to *watch* a leak grow
(or confirm a fix holds) while you click around the app.

The HUD page opens in your default browser automatically (pass `--no-open` to suppress
it and just use the printed URL). It is served by a dependency-free Node `http` server
and updates over [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events).

It has two targeting modes:

**Attach mode (recommended) — measure the browser you're actually driving.** Launch
Chrome yourself with remote debugging, interact normally, and attach the HUD. It binds to
the browser-level endpoint and never navigates or closes your browser.

```sh
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile   # open your page
npx cdp-gpu-probe hud --attach=9222
#   HUD:   http://127.0.0.1:53219/
#   attached to 127.0.0.1:9222 · whole browser every 1000ms — Ctrl-C to stop
```

`--attach` takes a port or `host:port`. The GPU process serves *every* tab, so attach
measures the whole Chrome instance — run a **dedicated profile with just the app under
test** for numbers that reflect it.

**Launch mode — zero setup, isolated.** Spawns its own headless Chrome and navigates it
to `--url` (Ctrl-C tears it down). Note this is a *different* Chrome from any you have
open, so it won't reflect clicks in your own browser — use attach mode for that.

```sh
npx cdp-gpu-probe hud --url=http://127.0.0.1:8080/webgl.html
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url=<url>` | — | Launch mode: page to load in a fresh headless Chrome |
| `--attach=<port>` | — | Attach mode: bind to a running Chrome's debug port (or `host:port`); measures the whole instance |
| `--interval=<ms>` | `1000` | Delay between samples |
| `--settle=<ms>` | `1500` | Wait before the first sample |
| `--port=<n>` | auto | HUD server port (default: an open port) |
| `--no-open` | off | Do not auto-open the HUD window (an isolated Chrome) |
| `--level=<detail>` | `detailed` | `background` \| `light` \| `detailed` |
| `--top=<n>` | `0` | Also stream the n largest individual GPU resources (GL textures, macOS shared images, Dawn textures) |

> Read the **GPU process footprint** tile as the source of truth — it tracks usage on
> every backend. The allocator tiles below it are Chrome's self-report, and may read flat
> next to a climbing footprint on macOS Metal (that's expected, not a bug).

There is also a second, **direct** HUD bin (`cdp-gpu-hud`) where the browser page itself is
the CDP client — embeddable, auto-re-attaching, but local-only. When to choose which, and
the architecture, are in [TECHNICAL.md](TECHNICAL.md#choosing-a-hud-direct-vs-cli).

### Common options (all commands)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--headed` | off | Show the browser window |
| `--chrome=<path>` | auto | Else `CDP_GPU_PROBE_CHROME` / `CHROME_PATH` |
| `--user-data-dir=<path>` | temp | Launch mode: reuse this Chrome profile (kept on exit); ignored when attaching |
| `--json` | off | Machine-readable output |
| `--out=<path>` | — | Also write JSON to a file (e.g. `test-results/gpu-mem.json`) |
| `--label=<text>` | — | Header label |

## Programmatic API

```js
import { probeGpuMemory, humanBytes } from '@graysonlang/cdp-gpu-probe';

const report = await probeGpuMemory({
  url: 'http://127.0.0.1:8080/webgl.html',
  samples: 6,
  intervalMs: 1000,
  topTextures: 5,
});
const last = report.samples.at(-1);
console.log('texture footprint:', humanBytes(last.textureBytes));
```

The `info` and `histograms` commands have matching entry points:

```js
import { probeGpuInfo, probeGpuHistograms } from '@graysonlang/cdp-gpu-probe';

const caps = await probeGpuInfo();                 // no url needed
console.log(caps.featureStatus.webgpu, caps.gl.renderer);

const stats = await probeGpuHistograms({ url: 'http://127.0.0.1:8080/webgl.html' });
console.log('context-loss/crash signals:', stats.health);
```

For embedding the direct HUD and the exported CDP primitives, see
[TECHNICAL.md](TECHNICAL.md#embedding-it-yourself).

## Requirements

- Node.js 22+ (global `WebSocket`).
- A Chrome/Chromium install. Headless software GL still reports texture sizes,
  because memory-infra computes them from the texture descriptors.

## Self-test

```sh
npm run selftest
```
</content>
