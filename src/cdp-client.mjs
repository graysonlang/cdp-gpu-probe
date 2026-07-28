// Minimal Chrome DevTools Protocol client over a WebSocket.
//
// Deliberately environment-agnostic: it uses only the global `WebSocket`, so the
// exact same client drives CDP from Node (the CLI bridge) and from a browser page
// talking directly to a Chrome launched with --remote-debugging-port (the direct
// HUD). Keeping it free of node:* is what lets the direct mode reuse it.

// CDP protocol messages are text (JSON). The non-string branches are defensive:
// browsers may hand back an ArrayBuffer for a binary frame, Node's global
// WebSocket a Buffer — decode either without assuming `Buffer` exists.
function decodeMessage(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(data)) return data.toString('utf8');
  return String(data);
}

// Default per-command timeout: covers the slowest CDP call we make (a detailed
// memory dump) with room to spare. Pass { timeoutMs } to override, or 0 to disable.
const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpClient {
  constructor(webSocket) {
    this.callbacks = new Map();
    this.handlers = new Map();
    this.id = 0;
    this.closed = false;
    this.webSocket = webSocket;

    webSocket.addEventListener('message', event => {
      const message = JSON.parse(decodeMessage(event.data));
      if (message.id) {
        const callback = this.callbacks.get(message.id);
        if (!callback) return;
        this.callbacks.delete(message.id);
        clearTimeout(callback.timer);
        if (message.error) {
          callback.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          callback.resolve(message.result || {});
        }
        return;
      }
      for (const handler of this.handlers.get(message.method) || []) {
        handler(message.params || {});
      }
    });
    webSocket.addEventListener('error', () => {
      this.closed = true;
      this.failPending(new Error('CDP WebSocket error.'));
    });
    webSocket.addEventListener('close', () => {
      this.closed = true;
      this.failPending(new Error('CDP WebSocket closed.'));
    });
  }

  static connect(webSocketUrl) {
    if (!globalThis.WebSocket) {
      throw new Error('A global WebSocket is required (Node 22+, or any browser).');
    }
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocket(webSocketUrl);
      webSocket.addEventListener('open', () => resolve(new CdpClient(webSocket)));
      webSocket.addEventListener('error', reject);
    });
  }

  close() {
    this.webSocket.close();
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(method);
    };
  }

  failPending(error) {
    for (const callback of this.callbacks.values()) {
      clearTimeout(callback.timer);
      callback.reject(error);
    }
    this.callbacks.clear();
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const openState = globalThis.WebSocket?.OPEN ?? 1;
    if (this.closed || this.webSocket.readyState !== openState) {
      return Promise.reject(new Error('CDP WebSocket is not open.'));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // Reject if Chrome never answers (socket alive but silent), so callers don't hang.
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.callbacks.delete(id);
          reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timer?.unref?.(); // don't keep the Node process alive on the timer
      }
      this.callbacks.set(id, { reject, resolve, timer });
      try {
        this.webSocket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.callbacks.delete(id);
        reject(error);
      }
    });
  }
}
