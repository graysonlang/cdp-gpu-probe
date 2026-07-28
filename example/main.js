// This import+export keeps index.html in the bundle graph so esbuild copies it to
// www/ and doesn't tree-shake the reference away. (Same idiom as the esp-template project.)
import index from './index.html';
export function getFilePaths() {
  return { index };
}

// WebGL textures are 512² (1 MiB) — enough to chart, and the canvas draws one. WebGPU
// uses 2048² (16 MiB): small incremental WebGPU writes get recycled below the noise in
// the GPU-process dump, but large ones persist and visibly move gpu/transfer_memory —
// which is the whole point of the example.
const TEX_SIZE = 512;
const TEX_BYTES = TEX_SIZE * TEX_SIZE * 4;
const GPU_TEX_SIZE = 2048;
const GPU_TEX_BYTES = GPU_TEX_SIZE * GPU_TEX_SIZE * 4;
const BATCH = 4;
const LEAK_INTERVAL_MS = 1000;

// Build the demo's source texture procedurally — a gradient drawn on a canvas, uploaded as
// an ImageBitmap. createImageBitmap(canvas) + texImage2D(ImageBitmap) is the exact upload
// path that motivated this tool, so the demo exercises it rather than allocating empty
// texture storage. The content itself doesn't matter (`unique` mode below swaps in fresh
// noise to defeat Chrome's identical-image dedup).
async function makeSourceBitmap() {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, TEX_SIZE, TEX_SIZE);
  gradient.addColorStop(0, '#ff5000');
  gradient.addColorStop(1, '#0078ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  return createImageBitmap(canvas);
}

const VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle from gl_VertexID — no vertex buffers needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 color;
void main() {
  color = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }
  return shader;
}

function makeProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
  }
  return program;
}

// Fill a fresh RGBA buffer with random bytes so each texture's content is unique —
// defeats Chrome's identical-image dedup (transfer cache / IOSurface sharing), which
// otherwise lets repeated uploads of the same bitmap collapse to one allocation.
// crypto.getRandomValues caps at 65536 bytes per call, so fill in chunks.
function makeNoise(bytes = TEX_BYTES) {
  const pixels = new Uint8Array(bytes);
  for (let off = 0; off < pixels.length; off += 65536) {
    crypto.getRandomValues(pixels.subarray(off, Math.min(off + 65536, pixels.length)));
  }
  return pixels;
}

// Holds the WebGL side of the demo: a list of live textures and a draw of the latest.
// With `unique`, each texture uploads fresh noise instead of the shared bitmap.
function createWebglDemo(canvas, bitmap, unique = false) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 is not available.');
  const program = makeProgram(gl);
  const textures = [];

  function uploadTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (unique) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        TEX_SIZE,
        TEX_SIZE,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        makeNoise(),
      );
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    }
    textures.push(texture);
  }

  function draw() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.05, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const latest = textures.at(-1);
    if (latest) {
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, latest);
      gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  return {
    add(n = BATCH) {
      for (let i = 0; i < n; i++) uploadTexture();
      draw();
    },
    free() {
      for (const texture of textures) gl.deleteTexture(texture);
      textures.length = 0;
      draw();
      gl.flush(); // push the deletes to the GPU process promptly
    },
    get count() {
      return textures.length;
    },
  };
}

// WebGPU side. Crucially it *writes* each texture/buffer with unique data: an empty
// createTexture is deferred by Dawn and never becomes real GPU memory, so it wouldn't
// move the probe at all. writeTexture/writeBuffer materialize the backing — that's what
// shows up under gpu/transfer_memory and makes this a valid demonstration of the HUD.
// Resolves to { available:false } when WebGPU is unavailable.
async function createWebgpuDemo() {
  if (!navigator.gpu) return { available: false, reason: 'navigator.gpu missing' };
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false, reason: 'no adapter' };
    device = await adapter.requestDevice();
  } catch (error) {
    return { available: false, reason: error.message };
  }

  const textures = [];
  const buffers = [];
  return {
    available: true,
    add(n = BATCH) {
      for (let i = 0; i < n; i++) {
        const data = makeNoise(GPU_TEX_BYTES); // unique 16 MiB per upload
        const texture = device.createTexture({
          size: [GPU_TEX_SIZE, GPU_TEX_SIZE],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture },
          data,
          { bytesPerRow: GPU_TEX_SIZE * 4, rowsPerImage: GPU_TEX_SIZE },
          { width: GPU_TEX_SIZE, height: GPU_TEX_SIZE },
        );
        textures.push(texture);
      }
      const buffer = device.createBuffer({
        size: GPU_TEX_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, makeNoise(GPU_TEX_BYTES));
      buffers.push(buffer);
    },
    free() {
      for (const texture of textures) texture.destroy();
      for (const buffer of buffers) buffer.destroy();
      textures.length = 0;
      buffers.length = 0;
      // destroy() only marks resources for reclamation; Dawn frees the backing on the next
      // device tick. Submit an empty queue so the memory is actually released even when
      // nothing else is running (otherwise "Free all" with the leak off does ~nothing).
      device.queue.submit([]);
    },
    get count() {
      return textures.length;
    },
  };
}

function renderReadout(element, webgl, webgpu) {
  const lines = [];
  lines.push(`WebGL textures: ${webgl.count}  (≈ ${webgl.count} MiB at ${TEX_SIZE}²)`);
  lines.push(
    webgpu.available
      ? `WebGPU textures: ${webgpu.count}`
      : `WebGPU: unavailable (${webgpu.reason})`,
  );
  element.textContent = lines.join('\n');
}

window.addEventListener('load', async () => {
  const canvas = document.getElementById('gl');
  const readout = document.getElementById('readout');

  const params = new URLSearchParams(location.search);
  const bitmap = await makeSourceBitmap();
  // Upload unique random pixels per texture by default so the allocations are real;
  // ?dedup forces re-uploading one bitmap to demonstrate Chrome's identical-image dedup.
  const webgl = createWebglDemo(canvas, bitmap, !params.has('dedup'));
  const webgpu = await createWebgpuDemo();

  const refresh = () => renderReadout(readout, webgl, webgpu);

  const bind = (id, action) =>
    document.getElementById(id).addEventListener('click', () => {
      action();
      refresh();
    });
  bind('webgl-add', () => webgl.add());
  bind('webgl-free', () => webgl.free());
  bind('webgpu-add', () => webgpu.add?.());
  bind('webgpu-free', () => webgpu.free?.());
  bind('free-all', () => {
    webgl.free();
    webgpu.free?.();
  });

  // Leak mode: keep allocating on a timer without ever freeing, so the probe's GPU
  // total climbs across samples — the leak signal. Drives BOTH WebGL and WebGPU each
  // tick; the WebGPU writes are what visibly move the HUD's gpu/transfer_memory on
  // macOS (WebGL textures get recycled out of the GPU process's resident pool).
  // Load with ?leak to auto-start it (no clicks needed) for headless regression runs.
  let leakTimer = null;
  const leakButton = document.getElementById('leak');
  const setLeak = on => {
    if (on && !leakTimer) {
      leakTimer = setInterval(() => {
        webgl.add(1);
        webgpu.add?.(1);
        refresh();
      }, LEAK_INTERVAL_MS);
    } else if (!on && leakTimer) {
      clearInterval(leakTimer);
      leakTimer = null;
    }
    leakButton.textContent = `Leak: ${leakTimer ? 'on' : 'off'}`;
    leakButton.setAttribute('aria-pressed', String(Boolean(leakTimer)));
  };
  leakButton.addEventListener('click', () => setLeak(!leakTimer));

  // Start with one batch so a default probe run has something to measure.
  webgl.add();
  webgpu.add?.();
  refresh();

  if (params.has('leak')) setLeak(true);
});
