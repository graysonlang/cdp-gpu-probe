# cdp-gpu-probe — technical notes

How the probe measures GPU memory, why the two numbers it reports differ, and the
protocol-level details behind the live HUDs. For usage and CLI flags see the
[README](README.md).

## How it measures

Both come from one memory-infra trace; the headline is #1.

1. **GPU process footprint — authoritative (the headline).** From the dump's
   `process_totals`: the kernel-reported **`private_footprint`** of the GPU process,
   GPU/Metal allocations included. It's the *same metric class as iOS jetsam's
   `phys_footprint`*, and it's the number that actually tracks GPU memory across every
   backend — including **WebGPU/Dawn on Metal**, where Chrome's allocator breakdown does
   not. Verified against a controlled 640 MiB WebGPU allocation (footprint rose ~628 MiB
   and climbs monotonically; the allocator total stayed flat). This is the point of an
   *external* probe: it's a real OS-level measurement, not the app's own tally.

   Caveat: footprint is **per-process** — the GPU process serves every tab, so it's
   "this Chrome's GPU memory," authoritative but whole-process. Measure a **dedicated
   profile** (the `hud` attach/launch modes encourage this) for per-app numbers.

2. **Allocator breakdown — Chrome's self-report (secondary).** The memory-infra
   allocator nodes; the probe surfaces every live `gpu/*` node (data-driven) so you can
   see *where* memory sits. Reliable on SwiftShader/Linux (`gpu/gl/textures`,
   `gpu/gl/buffers`) and for macOS WebGL (`gpu/shared_images`), but **incomplete for
   WebGPU/Dawn on Metal**: persistent texture storage isn't itemized — you mostly see
   transient `gpu/transfer_memory` staging that recycles, so it reads sticky/flat even
   while real memory grows. Treat it as a *where-ish* hint, not the total.

### Where the breakdown's bytes land (by backend)

For the #2 allocator breakdown, *which* node holds the bytes depends on the backend — so
don't read one named node and conclude "zero" (the footprint is the number to trust):

| Backend | Allocator node |
| --- | --- |
| SwiftShader / Linux GL | `gpu/gl/textures`, `gpu/gl/buffers` |
| macOS Metal/ANGLE (WebGL) | `gpu/shared_images` (IOSurface-backed; `gpu/gl/textures` reads 0) |
| WebGPU / Dawn (incl. macOS Metal) | `gpu/transfer_memory` (transient upload staging; recycles — unreliable. Use the footprint) |

So on macOS Metal a flat allocator reading next to a climbing footprint is expected, not a
bug: the GL `Textures` node/tile reads 0 (WebGL textures live under `gpu/shared_images` /
`Images / IOSurfaces`) and WebGPU/Dawn only flickers through `gpu/transfer_memory` staging.
Read the footprint; use `--json` for the raw keys.

## Choosing a HUD: direct vs CLI

There are two ways to get a *live* HUD, and they differ in **which side speaks CDP** —
which in turn decides what you have to configure. Both render in the browser; "direct" vs
"relayed" is about the data path, not where the pixels are.

- **Direct HUD** (`cdp-gpu-hud`, below): the browser page *is* the CDP client, talking
  straight to Chrome.
- **CLI / SSE HUD** (`cdp-gpu-probe hud`): Node holds the CDP connection, samples, and
  relays each tick to a passive page over Server-Sent Events.

| | Direct HUD (`cdp-gpu-hud`) | CLI / SSE HUD (`cdp-gpu-probe hud`) |
| --- | --- | --- |
| CDP client | the browser page | Node |
| Needs `--remote-allow-origins` | **yes** | **no** |
| Works headless / CI / scripted | no | **yes** |
| Best for | daily-driver live HUD, embeddable in your app | automation, snapshots, least local config |

**Why the config difference (the key technical note):** a *browser* WebSocket always sends
an `Origin` header, and since Chrome 111 the CDP debug socket rejects (403) any origin not
listed in `--remote-allow-origins`. Node's WebSocket sends *no* `Origin`, so it sails
through that check. That's why the direct HUD needs `--remote-allow-origins=<its origin>`
on the app's Chrome, while the CLI HUD needs nothing beyond `--remote-debugging-port`. (It
is *not* classic CORS — it's Chrome's `Origin` allowlist on the debug socket specifically;
classic CORS is *separately* why the direct HUD can't self-discover its ws from the `/json`
endpoints and must be handed one — see [Embedding it yourself](#embedding-it-yourself).)

The second axis is **headlessness**: because Node is the client in the CLI path, it runs
with no display — so CI, scripted runs, `--json` snapshots, and the one-shot `memory` /
`histograms` / `info` commands all work without a browser to host the client. The direct
HUD *requires* a browser to exist and be the client, so it's inherently local/interactive.

**So:** reach for the **CLI HUD** when you want the fewest local knobs or you're running
headless/CI; reach for the **direct HUD** when you want a self-contained, embeddable
daily-driver that survives app restarts (auto-re-attach) with no Node process babysitting
it.

## Direct HUD — `cdp-gpu-hud` (zero host wiring)

For local development, the **`cdp-gpu-hud`** bin opens the HUD with nothing in your repo
but a Chrome flag. It serves the HUD itself (no build entry, no page, no opener), opens it
in an **isolated Chrome window** (its own profile = its own GPU process, so the HUD's own
rendering doesn't pollute the GPU you're measuring), and **auto-re-attaches** when the
app's Chrome restarts.

```sh
# 1. Launch the app's Chrome with the debug port AND allow the HUD's origin:
chrome --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9292
# 2. Open the HUD (separate window; close it to stop):
npx cdp-gpu-hud            # --attach=9222 --hud-port=9292 by default; --text for no canvas
```

The HUD reads the app's GPU stats over CDP and renders in its own window. If the app's
Chrome is torn down and relaunched (e.g. you restart your debug session), the HUD
re-resolves through the bin's `/ws` endpoint and **keeps sampling** — no manual reload.

The `--remote-allow-origins` flag is required because the HUD page is a browser CDP client
(served from `http://127.0.0.1:9292`); `*` works for local dev. See [the Origin
explanation above](#choosing-a-hud-direct-vs-cli). If your dev harness launches Chrome for
you, add the flag there.

**Layout:** a status header, then sortable **Footprints / Allocator rollups / Largest
resources** tables. Each footprint/rollup row's leftmost column is a **checkbox that toggles
a sparkline chart** for that metric at the top (the footprints are charted by default; click
a column header to sort the rollups). `cdp-gpu-hud --text` (or `GPU_HUD_TEXT=1`, or `?text`)
just **starts with no charts ticked** — pure tables, no GPU-backed canvases until you tick a
row, so the least HUD overhead. `?console` is a blank-page control (DevTools logs only).

> **Observer effect:** the isolated-Chrome window keeps the HUD's rendering out of the
> measured GPU process. For *pristine absolute* numbers you can still use the CLI bridge
> (`cdp-gpu-probe hud`), which renders in a wholly separate browser; `--text` minimizes the
> HUD's own cost either way.

### Embedding it yourself

If you'd rather bundle the HUD into your own app (or build custom launch glue), import the
pieces directly:

```js
import { startDirectHud } from '@graysonlang/cdp-gpu-probe/direct';
// By default it fetches a same-origin `/ws` endpoint returning { ws, label } and
// re-resolves there to auto-re-attach. Override with { discover: '/path' }, or hand it a
// ws directly via { ws } / ?ws= / ?port=&id= / window.__GPU_WS__. hud.stop() to end.
const hud = await startDirectHud();
```

`CdpClient`, `getBrowserWebSocketUrl`, `listPageTargets`, `findChromePath`, and
`parseDebugTarget` are exported from the package root for building your own launcher (the
bin is ~80 lines of exactly that). The page can't discover its own ws (`/json` isn't
CORS-enabled even with `--remote-allow-origins`), so something Node-side must resolve it —
the bin's same-origin `/ws` endpoint (the default), or hand the page a ws via
`window.__GPU_WS__` / `?ws=`.

### Reference: how the bin is wired into the example

The HUD is kept a separate concern from running the app:

- **"Debug in Chrome"** ([`.vscode/launch.json`](.vscode/launch.json)) just launches the
  app — no HUD — and carries `--remote-allow-origins=http://127.0.0.1:9292` so the HUD
  *can* attach. This is the everyday "run my app" config.
- **"GPU HUD (isolated)"** is a `node` launch that runs `bin/cdp-gpu-hud.mjs --attach=9222`.
- **"Debug in Chrome + GPU HUD"** is the compound that runs both.

So the app launch and the HUD are independent: launch the app alone, then sample however
you like — the HUD compound, `npm run gpu:hud` in a terminal, or `cdp-gpu-probe` CLI. The
dev-server build script ([`scripts/build.mjs`](scripts/build.mjs)) is *only* an esbuild
invoker — it doesn't touch the HUD. No HUD page or opener lives in the example.
