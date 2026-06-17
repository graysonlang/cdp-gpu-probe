// Synthetic-event test for the trace parser. No Chrome needed.
import assert from 'node:assert/strict';
import { collectGpuDumps, indexProcessNames, summarizeDump } from '../src/memory-infra.mjs';

// hex byte sizes
const MiB = 0x100000;
const size = mib => ({ attrs: { size: { type: 'scalar', units: 'bytes', value: (mib * MiB).toString(16) } } });

// Two processes share one global dump id. The renderer reports the texture as a
// non-owning client node (effective size 0); the GPU process owns it. We must
// read the GPU process and not double count.
const events = [
  { ph: 'M', name: 'process_name', pid: 100, args: { name: 'Browser' } },
  { ph: 'M', name: 'process_name', pid: 200, args: { name: 'Renderer' } },
  { ph: 'M', name: 'process_name', pid: 300, args: { name: 'GPU Process' } },
  // Renderer-side client mirror — should be ignored.
  {
    ph: 'v', id: 'dump-1', pid: 200, ts: 1000,
    args: { dumps: { allocators: { 'gpu/gl/textures/client_0/texture_9': { attrs: { size: { value: '0' } } } } } },
  },
  // GPU process, dump 1.
  {
    ph: 'v', id: 'dump-1', pid: 300, ts: 1000,
    args: { dumps: { allocators: {
      'gpu': size(50),
      'gpu/gl': size(40),
      'gpu/gl/textures': size(32),
      'gpu/gl/buffers': size(8),
      'gpu/gl/textures/share_group_0/texture_1': size(24),
      'gpu/gl/textures/share_group_0/texture_2': size(8),
    } } },
  },
  // GPU process, dump 2 — textures grew (a leak signal).
  {
    ph: 'v', id: 'dump-2', pid: 300, ts: 2000,
    args: { dumps: { allocators: {
      'gpu': size(74),
      'gpu/gl/textures': size(64),
      'gpu/gl/buffers': size(8),
      'gpu/gl/textures/share_group_0/texture_1': size(24),
      'gpu/gl/textures/share_group_0/texture_2': size(8),
      'gpu/gl/textures/share_group_0/texture_3': size(32),
    } } },
  },
];

const names = indexProcessNames(events);
assert.equal(names.get(300), 'GPU Process');

const dumps = collectGpuDumps(events, names);
assert.equal(dumps.length, 2, 'two GPU dumps');
assert.equal(dumps[0].pid, 300, 'picked the GPU process, not the renderer');

const first = summarizeDump(dumps[0], 3);
assert.equal(first.gpuTotalBytes, 50 * MiB);
assert.equal(first.textureBytes, 32 * MiB);
assert.equal(first.bufferBytes, 8 * MiB);
assert.equal(first.topTextures.length, 2);
assert.equal(first.topTextures[0].bytes, 24 * MiB, 'largest texture first');

const second = summarizeDump(dumps[1], 3);
assert.equal(second.textureBytes, 64 * MiB);
// GL texture nodes are relabeled as "texture_N (<ctx>)" for display.
assert.equal(second.topTextures[0].name, 'texture_3 (share_group_0)');

// macOS Metal / WebGPU: rank shared-image (mailbox) and Dawn texture nodes too, with
// readable labels — never the /element_N backing (double count) or the client_* aggregate.
const metalDump = {
  process: 'GPU Process',
  allocators: {
    'gpu/shared_images': size(50),
    'gpu/shared_images/client_0x0': size(50),
    'gpu/shared_images/client_0x0/mailbox_AA:BB:CC': size(30),
    'gpu/shared_images/client_0x0/mailbox_AA:BB:CC/element_0': size(30),
    'gpu/dawn/device_0x1/texture_0xabc': size(20),
  },
  processTotals: null,
};
const metal = summarizeDump(metalDump, 10);
assert.equal(metal.topTextures.length, 2, 'mailbox + dawn texture, not element_0/aggregates');
assert.equal(metal.topTextures[0].name, 'shared image client_0x0 …AA:BB:CC');
assert.equal(metal.topTextures[0].bytes, 30 * MiB);
assert.equal(metal.topTextures[1].name, 'dawn texture_0xabc');

// delta the report would show
assert.equal(second.gpuTotalBytes - first.gpuTotalBytes, 24 * MiB, 'growth detected');

console.log('ok - trace parser picks GPU process, ignores client mirror, ranks textures, detects growth');
