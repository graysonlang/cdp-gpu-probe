import assert from 'node:assert/strict';
import { CdpClient } from '../src/cdp-client.mjs';
import { captureGpuMemory } from '../src/memory-infra.mjs';

class DataEvent extends Event {
  constructor(type, data) {
    super(type);
    this.data = data;
  }
}

class FakeWebSocket extends EventTarget {
  readyState = 1;
  sent = [];

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  emit(message) {
    this.dispatchEvent(new DataEvent('message', JSON.stringify(message)));
  }
}

{
  const socket = new FakeWebSocket();
  const client = new CdpClient(socket);

  let eventTotal = 0;
  const off = client.on('Test.event', params => {
    eventTotal += params.value;
  });
  socket.emit({ method: 'Test.event', params: { value: 2 } });
  off();
  socket.emit({ method: 'Test.event', params: { value: 8 } });
  assert.equal(eventTotal, 2, 'event unsubscribe removes temporary handlers');

  const response = client.send('Runtime.evaluate', { expression: '1 + 1' });
  socket.emit({ id: socket.sent.at(-1).id, result: { value: 2 } });
  assert.deepEqual(await response, { value: 2 }, 'send resolves matching CDP responses');

  // The command timer is unref'd (won't hold a real process open); the FakeWebSocket has
  // no handle keeping the loop alive, so hold it open with a ref'd timer while we await.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(
    client.send('Runtime.evaluate', { expression: 'never replies' }, { timeoutMs: 10 }),
    /timed out/,
    'send rejects when Chrome never replies',
  );
  clearTimeout(keepAlive);

  const pending = client.send('Runtime.evaluate', { expression: 'while(true){}' });
  socket.close();
  await assert.rejects(pending, /closed/, 'socket close rejects pending sends');
  await assert.rejects(
    client.send('Runtime.evaluate', { expression: '1' }),
    /not open/,
    'closed client rejects new sends',
  );
}

class FakeTraceClient {
  handlers = new Map();
  sent = [];

  on(method, handler) {
    const handlers = this.handlers.get(method) || new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(method);
    };
  }

  emit(method, params = {}) {
    for (const handler of this.handlers.get(method) || []) handler(params);
  }

  async send(method) {
    this.sent.push(method);
    if (method === 'Tracing.requestMemoryDump') return { success: false };
    if (method === 'Tracing.end') this.emit('Tracing.tracingComplete');
    return {};
  }
}

{
  const client = new FakeTraceClient();
  await assert.rejects(
    captureGpuMemory(client, { settleMs: 0 }),
    /memory dump failed/,
    'failed memory dumps keep their original error',
  );
  assert.deepEqual(
    client.sent,
    ['Tracing.start', 'Tracing.requestMemoryDump', 'Tracing.end'],
    'failed captures still end the trace',
  );
  assert.equal(client.handlers.size, 0, 'trace event handlers are removed after capture');
}

console.log(
  'ok - CDP lifecycle rejects closed sends, unsubscribes handlers, and ends failed traces',
);
