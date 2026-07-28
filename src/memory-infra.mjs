// Capture and interpret Chrome memory-infra dumps over CDP.
//
// Background: WebGL/WebGPU resources are allocated in Chrome's GPU process, not
// in the renderer the JS heap profiler sees. memory-infra is Chrome's own
// accounting of that process. We start a trace with the memory-infra category,
// ask for one or more explicit dumps, then read the GPU process's allocator
// nodes. For a texture's true footprint, read the `size` (not effective size)
// of the GPU process `gpu` / `gpu/gl/textures` nodes; the renderer side shows
// the same texture with an effective size of 0, so filtering to the GPU
// process avoids double counting.

import { sleep } from './util.mjs';

const MEMORY_INFRA_CATEGORY = 'disabled-by-default-memory-infra';
const TRACE_END_TIMEOUT_MS = 5000;

// Which allocator nodes we surface as rollups. Data-driven rather than a fixed list,
// because the interesting bucket differs by backend: GL textures/buffers on
// SwiftShader, gpu/shared_images (IOSurface-backed textures) on macOS Metal, and
// gpu/transfer_memory for WebGPU/Dawn — a fixed GL-centric list missed the last one,
// which is why WebGPU memory looked like it wasn't tracked. We surface the `gpu` total,
// every direct child of it (gpu/transfer_memory, gpu/dawn, gpu/shared_images, gpu/gl, …),
// the GL leaf split, and the sibling GPU allocators skia/cc.
const GPU_CHILD = /^gpu\/[^/]+$/;
const NAMED_ROLLUPS = new Set([
  'gpu/gl/textures',
  'gpu/gl/buffers',
  'gpu/gl/renderbuffers',
  'skia/gpu_resources',
  'cc/tile_memory',
]);

function isRollupNode(name) {
  return name === 'gpu' || GPU_CHILD.test(name) || NAMED_ROLLUPS.has(name);
}

function parseSizeAttr(node) {
  const value = node?.attrs?.size?.value;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Parse a byte value; memory-infra encodes process_totals sizes as hex strings.
function parseBytes(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A process's authoritative OS-level footprint from the dump's process_totals: the
// kernel-reported private memory the process owns (GPU/Metal allocations included),
// not Chrome's self-reported allocator breakdown. private_footprint is the macOS
// metric (and jetsam's phys_footprint class); resident_set is the fallback elsewhere.
function parseFootprint(totals) {
  if (!totals) return 0;
  return (
    parseBytes(totals.private_footprint_bytes) ||
    parseBytes(totals.resident_set_bytes) ||
    (Number(totals.resident_set_kb) || 0) * 1024
  );
}

// Build pid -> friendly process name from metadata events.
function indexProcessNames(events) {
  const names = new Map();
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'process_name' && event.args?.name) {
      names.set(event.pid, event.args.name);
    }
  }
  return names;
}

// Group memory-dump events by dump id (a "global" dump fans out into one event
// per process, all sharing the same id), then keep only the GPU process.
function collectGpuDumps(events, processNames) {
  const gpuPids = new Set();
  for (const [pid, name] of processNames) {
    if (/gpu process/i.test(name)) gpuPids.add(pid);
  }

  const dumps = new Map();
  for (const event of events) {
    const isMemoryDump = event.ph === 'v' || event.ph === 'V';
    const allocators = event.args?.dumps?.allocators;
    if (!isMemoryDump || !allocators) continue;

    // Prefer the real GPU process. If headless software GL folded everything
    // into another process, fall back to whichever process actually reports
    // gpu/* allocations so the tool still returns a number.
    const isGpuProcess = gpuPids.has(event.pid);
    const reportsGpu = Object.keys(allocators).some(name => name.startsWith('gpu'));
    if (!isGpuProcess && !(gpuPids.size === 0 && reportsGpu)) continue;

    const id = event.id ?? `${event.pid}:${event.ts}`;
    if (!dumps.has(id)) {
      dumps.set(id, {
        id,
        ts: event.ts,
        pid: event.pid,
        process: processNames.get(event.pid) || `pid ${event.pid}`,
        allocators: {},
        processTotals: event.args?.dumps?.process_totals || null,
      });
    }
    Object.assign(dumps.get(id).allocators, allocators);
  }
  return [...dumps.values()].sort((a, b) => a.ts - b.ts);
}

// Authoritative per-process footprints keyed by global dump id. A global dump fans out
// one event per process sharing an id, so we can read the renderer's footprint and
// correlate it with the GPU dump of the same tick. Renderers are summed (a page can
// spawn several); the GPU process is what summarizeDump reports as the headline.
function collectFootprints(events, processNames) {
  const byId = new Map();
  for (const event of events) {
    const totals = event.args?.dumps?.process_totals;
    if ((event.ph !== 'v' && event.ph !== 'V') || !totals) continue;
    const id = event.id ?? `${event.pid}:${event.ts}`;
    const name = processNames.get(event.pid) || '';
    const entry = byId.get(id) || { gpu: 0, renderer: 0 };
    const footprint = parseFootprint(totals);
    if (/gpu process/i.test(name)) entry.gpu = footprint;
    else if (/renderer/i.test(name)) entry.renderer += footprint;
    byId.set(id, entry);
  }
  return byId;
}

// Individual GPU resources we can rank for the "largest resources" list — one row per
// resource, never the aggregate parent nodes. Backends itemize differently:
//   GL / SwiftShader:  gpu/gl/textures/<ctx>/texture_N
//   macOS Metal/ANGLE: gpu/shared_images/<client>/mailbox_<guid>  (IOSurface-backed images;
//                      the per-image node — its /element_N children are the same bytes, so
//                      we match the mailbox and skip them to avoid double-listing)
//   WebGPU / Dawn:     gpu/dawn/<device>/texture_<addr>
const RESOURCE_NODE =
  /^(?:gpu\/gl\/textures\/.+\/texture_\d+|gpu\/shared_images\/[^/]+\/mailbox_[^/]+|gpu\/dawn\/[^/]+\/texture_[^/]+)$/;

// A readable label for a resource node — the raw paths carry long mailbox GUIDs / pointers.
function resourceLabel(name) {
  const shared = name.match(/^gpu\/shared_images\/(client_[^/]+)\/mailbox_(.+)$/);
  if (shared) {
    const tail = shared[2].split(':').slice(-3).join(':');
    return `shared image ${shared[1]} …${tail}`;
  }
  const dawn = name.match(/^gpu\/dawn\/[^/]+\/(texture_[^/]+)$/);
  if (dawn) return `dawn ${dawn[1]}`;
  const gl = name.match(/^gpu\/gl\/textures\/([^/]+)\/(texture_\d+)$/);
  if (gl) return `${gl[2]} (${gl[1]})`;
  return name.replace(/^gpu\//, '');
}

function summarizeDump(dump, topTextures) {
  const allocators = dump.allocators;
  const rollups = {};
  for (const [name, node] of Object.entries(allocators)) {
    if (isRollupNode(name)) rollups[name] = parseSizeAttr(node);
  }

  let textures = [];
  if (topTextures > 0) {
    textures = Object.entries(allocators)
      .filter(([name]) => RESOURCE_NODE.test(name))
      .map(([name, node]) => ({ name: resourceLabel(name), bytes: parseSizeAttr(node) }))
      .filter(resource => resource.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, topTextures);
  }

  return {
    process: dump.process,
    tsMicros: dump.ts,
    // Authoritative headline: the GPU process's kernel-reported private footprint
    // (GPU/Metal allocations included). The rollups below are Chrome's self-reported
    // allocator breakdown — useful, but incomplete for WebGPU/Dawn on Metal.
    gpuProcessFootprintBytes: parseFootprint(dump.processTotals),
    gpuTotalBytes: rollups.gpu ?? 0,
    textureBytes: rollups['gpu/gl/textures'] ?? 0,
    bufferBytes: rollups['gpu/gl/buffers'] ?? 0,
    rollups,
    topTextures: textures,
  };
}

// Drive the trace. Caller passes a connected CdpClient.
export async function captureGpuMemory(client, options = {}) {
  const {
    levelOfDetail = 'detailed',
    samples = 1,
    intervalMs = 1000,
    settleMs = 1500,
    topTextures = 0,
    includeRaw = false,
    onSample = null,
  } = options;

  const events = [];
  let tracingComplete;
  const completed = new Promise(resolve => {
    tracingComplete = resolve;
  });
  let tracingActive = false;
  let tracingEnded = false;

  const offDataCollected =
    client.on('Tracing.dataCollected', params => {
      if (Array.isArray(params.value)) events.push(...params.value);
    }) || (() => {});
  const dumpGuids = [];
  const offTracingComplete =
    client.on('Tracing.tracingComplete', () => tracingComplete()) || (() => {});

  async function stopTracing({ quiet } = {}) {
    if (!tracingActive || tracingEnded) return;
    tracingEnded = true;
    try {
      await client.send('Tracing.end');
      const finished = await Promise.race([
        completed.then(() => true),
        sleep(TRACE_END_TIMEOUT_MS).then(() => false),
      ]);
      if (!finished && !quiet) {
        throw new Error('Timed out waiting for Chrome to finish the memory trace.');
      }
    } catch (error) {
      if (!quiet) throw error;
    }
  }

  try {
    await client.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordUntilFull',
        includedCategories: [MEMORY_INFRA_CATEGORY],
        memoryDumpConfig: { triggers: [] },
      },
    });
    tracingActive = true;

    if (settleMs > 0) await sleep(settleMs);

    for (let i = 0; i < Math.max(1, samples); i++) {
      if (i > 0 && intervalMs > 0) await sleep(intervalMs);
      const result = await client.send('Tracing.requestMemoryDump', {
        deterministic: true,
        levelOfDetail,
      });
      if (!result.success) {
        throw new Error(
          'Chrome reported the memory dump failed. Try --level=light, or give the page longer to settle.',
        );
      }
      dumpGuids.push(result.dumpGuid);
      if (onSample) onSample(i + 1);
    }

    await stopTracing();

    const processNames = indexProcessNames(events);
    const dumps = collectGpuDumps(events, processNames);
    if (dumps.length === 0) {
      throw new Error(
        'No GPU memory dumps were found in the trace. The page may not have created a GPU context yet.',
      );
    }
    const footprints = collectFootprints(events, processNames);

    return {
      levelOfDetail,
      requestedSamples: dumpGuids.length,
      samples: dumps.map(dump => {
        const sample = summarizeDump(dump, topTextures);
        // process_totals arrives in a separate event from allocators (same dump id), so
        // pull both footprints from the cross-process scan rather than the allocators dump.
        const ft = footprints.get(dump.id);
        sample.gpuProcessFootprintBytes = ft?.gpu || sample.gpuProcessFootprintBytes;
        sample.rendererFootprintBytes = ft?.renderer ?? 0;
        // The full raw GPU-process allocator dump + process_totals, for the HUD's
        // "download the entire GPU CDP dump" button. Off by default (keeps the CLI's
        // reports and the SSE messages lean unless a consumer opts in).
        if (includeRaw) {
          sample.allocators = dump.allocators;
          sample.processTotals = dump.processTotals;
        }
        return sample;
      }),
    };
  } finally {
    await stopTracing({ quiet: true });
    offDataCollected();
    offTracingComplete();
  }
}

export { MEMORY_INFRA_CATEGORY, collectGpuDumps, indexProcessNames, summarizeDump };
