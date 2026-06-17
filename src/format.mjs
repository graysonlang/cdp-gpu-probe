// Output formatting: byte humanization and a compact multi-sample table.

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(text, width) {
  const value = String(text);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

// Render the per-sample table with a delta column relative to the first sample.
export function formatReport(report, options = {}) {
  const { label } = options;
  const lines = [];
  const samples = report.samples;
  const base = samples[0];

  if (label) lines.push(`label:    ${label}`);
  lines.push(`process:  ${base.process}`);
  lines.push(`detail:   ${report.levelOfDetail}`);
  lines.push(`samples:  ${samples.length}`);
  lines.push('');

  // Headline is the GPU process's authoritative OS footprint (private_footprint);
  // gpu-alloc is Chrome's self-reported allocator total (incomplete for WebGPU/Dawn).
  const header = `${pad('#', 4)}${padStart('footprint', 14)}${padStart('Δ footprint', 14)}${padStart('gpu alloc', 14)}${padStart('textures', 12)}`;
  lines.push(header);
  lines.push('-'.repeat(header.length));
  samples.forEach((sample, index) => {
    const delta = sample.gpuProcessFootprintBytes - base.gpuProcessFootprintBytes;
    const deltaText = index === 0 ? '-' : `${delta >= 0 ? '+' : ''}${humanBytes(delta)}`;
    lines.push(
      pad(index + 1, 4)
      + padStart(humanBytes(sample.gpuProcessFootprintBytes), 14)
      + padStart(deltaText, 14)
      + padStart(humanBytes(sample.gpuTotalBytes), 14)
      + padStart(humanBytes(sample.textureBytes), 12),
    );
  });
  lines.push('');
  lines.push('footprint = GPU process private_footprint (authoritative, incl. GPU/Metal memory);');
  lines.push('gpu alloc = Chrome\'s self-reported allocator total (a partial breakdown).');

  const last = samples[samples.length - 1];
  if (last.rendererFootprintBytes) {
    lines.push(`renderer process footprint (final): ${humanBytes(last.rendererFootprintBytes)}`);
  }
  const otherRollups = Object.entries(last.rollups)
    .filter(([name]) => !['gpu', 'gpu/gl', 'gpu/gl/textures', 'gpu/gl/buffers'].includes(name))
    .sort((a, b) => b[1] - a[1]);
  if (otherRollups.length) {
    lines.push('');
    lines.push('allocator breakdown (Chrome self-reported, final sample):');
    for (const [name, bytes] of otherRollups) {
      lines.push(`  ${pad(name, 24)}${padStart(humanBytes(bytes), 12)}`);
    }
  }

  if (last.topTextures.length) {
    lines.push('');
    lines.push(`top ${last.topTextures.length} GPU resources (final sample):`);
    for (const texture of last.topTextures) {
      lines.push(`  ${pad(texture.name, 36)}${padStart(humanBytes(texture.bytes), 12)}`);
    }
  }

  return lines.join('\n');
}

function describeVideoProfile(profile) {
  const codec = profile.profile ?? profile.codec ?? 'profile';
  const max = profile.maxResolution;
  const range = max ? ` up to ${max.width}x${max.height}` : '';
  return `${codec}${range}`;
}

// Render the SystemInfo.getInfo capability report.
export function formatSystemInfo(info, options = {}) {
  const { label } = options;
  const lines = [];

  if (label) lines.push(`label:    ${label}`);
  lines.push('GPU');
  if (info.modelName) lines.push(`  model:    ${info.modelName}${info.modelVersion ? ` ${info.modelVersion}` : ''}`);
  if (info.devices.length === 0) lines.push('  device:   (none reported)');
  for (const device of info.devices) {
    const driver = [device.driverVendor, device.driverVersion].filter(Boolean).join(' ');
    const active = device.active ? '  [active]' : '';
    lines.push(`  device:   ${device.vendor || '?'} ${device.device || ''}${driver ? `  (driver ${driver})` : ''}${active}`);
  }
  if (info.gl.renderer) lines.push(`  gl:       ${info.gl.renderer}${info.gl.version ? ` — ${info.gl.version}` : ''}`);
  const backend = Object.entries(info.backend)
    .filter(([, value]) => value !== null && value !== false)
    .map(([key, value]) => `${key}=${value}`);
  if (backend.length) lines.push(`  backend:  ${backend.join('  ')}`);
  if (info.gpuProcess) lines.push(`  process:  ${info.gpuProcess.type} (cpuTime ${info.gpuProcess.cpuTime ?? '?'})`);

  const features = Object.entries(info.featureStatus).sort(([a], [b]) => a.localeCompare(b));
  if (features.length) {
    const width = Math.max(...features.map(([name]) => name.length));
    lines.push('');
    lines.push('feature status:');
    for (const [name, status] of features) {
      lines.push(`  ${pad(name, width + 2)}${status}`);
    }
  }

  lines.push('');
  if (info.driverBugWorkarounds.length) {
    lines.push(`driver bug workarounds (${info.driverBugWorkarounds.length}):`);
    for (const workaround of info.driverBugWorkarounds) lines.push(`  - ${workaround}`);
  } else {
    lines.push('driver bug workarounds: none');
  }

  if (info.video.decoding.length || info.video.encoding.length) {
    lines.push('');
    lines.push('hardware video:');
    if (info.video.decoding.length) lines.push(`  decode:   ${info.video.decoding.map(describeVideoProfile).join(', ')}`);
    if (info.video.encoding.length) lines.push(`  encode:   ${info.video.encoding.map(describeVideoProfile).join(', ')}`);
  }

  return lines.join('\n');
}

// Render the GPU histogram report (health signals first, then a matched-count summary).
export function formatHistograms(result, options = {}) {
  const { label, all = false } = options;
  const lines = [];

  if (label) lines.push(`label:    ${label}`);
  lines.push(`mode:     ${result.delta ? 'delta (around page lifetime)' : 'absolute (since launch)'}`);
  lines.push(`matched:  ${result.all.length} histograms`);
  lines.push('');

  const rows = all ? result.all : result.health;
  if (rows.length === 0) {
    lines.push(all ? 'no matching histograms recorded.' : 'no GPU health histograms recorded (no losses/crashes/errors).');
    return lines.join('\n');
  }

  lines.push(all ? 'all matched histograms:' : 'health (context loss / crashes / errors / lifetime):');
  const width = Math.max(...rows.map(row => row.name.length));
  for (const row of rows) {
    lines.push(`  ${pad(row.name, width + 2)}${padStart(`count ${row.count}`, 12)}${padStart(`sum ${row.sum}`, 14)}`);
  }
  if (!all && result.all.length > result.health.length) {
    lines.push('');
    lines.push(`(${result.all.length} matched total — pass --all or --json for the rest)`);
  }

  return lines.join('\n');
}
