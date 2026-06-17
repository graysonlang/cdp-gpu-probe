// Tiny dependency-free HTTP + Server-Sent Events server for the live HUD.
//
// It serves the static dashboard from ../hud and exposes /events as an SSE stream.
// SSE (not WebSocket) is deliberate: the data only ever flows server -> browser, and
// SSE rides plain HTTP with the browser's built-in EventSource, so there's no need to
// pull in a `ws` dependency. `broadcast(event, data)` fans a JSON payload out to every
// connected page; the runHud loop calls it once per sample.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUD_DIR = path.resolve(fileURLToPath(new URL('../hud', import.meta.url)));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// SSE keep-alive: proxies and browsers drop idle connections, so emit a comment line
// periodically. Comments (lines starting with ':') are ignored by EventSource.
const HEARTBEAT_MS = 15_000;

async function serveAsset(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Resolve within HUD_DIR and reject anything that escapes it (path traversal).
  const filePath = path.resolve(HUD_DIR, relative);
  if (filePath !== HUD_DIR && !filePath.startsWith(HUD_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

export async function startHudServer({ port } = {}) {
  const clients = new Set();
  // Last payload seen per event name. The browser usually connects a beat after the
  // probe starts (it has to launch first), so replay the retained events to each new
  // client — otherwise a one-shot event like `info` (GPU identity) is missed and the
  // page sits empty until the next sample.
  const retained = new Map();

  function frameOf(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      });
      res.write(': connected\n\n');
      for (const [event, data] of retained) res.write(frameOf(event, data));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    serveAsset(res, urlPath);
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', resolve);
  });

  const { port: actualPort } = server.address();
  const url = `http://127.0.0.1:${actualPort}/`;

  function broadcast(event, data) {
    retained.set(event, data);
    const frame = frameOf(event, data);
    for (const res of clients) res.write(frame);
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
    return new Promise(resolve => server.close(resolve));
  }

  return { url, port: actualPort, broadcast, close };
}
