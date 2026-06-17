// GPU identity, driver, and feature/acceleration status via CDP's SystemInfo
// domain — the structured form of chrome://gpu. Unlike memory-infra this needs
// no tracing: a single SystemInfo.getInfo call returns it all. SystemInfo.getInfo
// reflects the GPU state of the Chrome instance the probe launched, so it also
// explains *why* the memory numbers look the way they do (e.g. WebGL reported as
// software rather than hardware on a given machine).

// SystemInfo.getProcessInfo is not present on every Chrome channel; treat it as
// best-effort so `info` still works where it is missing.
async function getProcessInfo(client) {
  try {
    const { processInfo = [] } = await client.send('SystemInfo.getProcessInfo');
    return processInfo;
  } catch {
    return [];
  }
}

export async function captureSystemInfo(client) {
  const { gpu = {}, modelName, modelVersion } = await client.send('SystemInfo.getInfo');
  const processes = await getProcessInfo(client);
  const aux = gpu.auxAttributes || {};

  return {
    modelName: modelName || null,
    modelVersion: modelVersion || null,
    devices: (gpu.devices || []).map(device => ({
      vendorId: device.vendorId ?? null,
      deviceId: device.deviceId ?? null,
      vendor: device.vendorString || aux.glVendor || null,
      device: device.deviceString || aux.glRenderer || null,
      driverVendor: device.driverVendor || null,
      driverVersion: device.driverVersion || null,
      active: device.active ?? null,
    })),
    featureStatus: gpu.featureStatus || {},
    driverBugWorkarounds: gpu.driverBugWorkarounds || [],
    gl: {
      vendor: aux.glVendor || null,
      renderer: aux.glRenderer || null,
      version: aux.glVersion || null,
    },
    backend: {
      directComposition: aux.directComposition ?? null,
      directRendering: aux.directRendering ?? null,
      vulkanVersion: aux.vulkanVersion || null,
      sandboxed: aux.sandboxed ?? null,
    },
    video: {
      // Newer Chrome exposes these as GPUInfo arrays; older builds tuck the same
      // capability lists under auxAttributes. Accept whichever is present.
      decoding: gpu.videoDecoding || aux.videoDecodeAcceleratorSupportedProfile || [],
      encoding: gpu.videoEncoding || aux.videoEncodeAcceleratorSupportedProfile || [],
    },
    gpuProcess: processes.find(process => /gpu/i.test(process.type)) || null,
    raw: gpu,
  };
}
