import { createMiddlewareStack } from '../server/hosted/middleware.js';

function events() {
  const listeners = new Map();
  return {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); return this; },
    once(name, callback) { const once = (...args) => { this.removeListener(name, once); callback(...args); }; once.original = callback; return this.on(name, once); },
    removeListener(name, callback) { for (const listener of listeners.get(name) || []) if (listener === callback || listener.original === callback) listeners.get(name).delete(listener); return this; },
    emit(name, ...args) { for (const callback of [...listeners.get(name) || []]) callback(...args); },
  };
}

/** Adapt retained Connect-style handlers to Web Request/Response without Node shims. */
export function createWorkerMiddleware(providers) {
  const middlewares = createMiddlewareStack();
  const lifecycle = events();
  for (const plugin of providers) plugin.configureServer?.({ middlewares, httpServer: lifecycle });
  return {
    async handle(request) {
      const url = new URL(request.url);
      const req = Object.assign(events(), {
        url: url.pathname + url.search, method: request.method,
        headers: Object.fromEntries(request.headers),
        socket: { remoteAddress: request.headers.get('cf-connecting-ip') || 'unknown' },
      });
      const headers = new Headers(), chunks = [];
      const res = Object.assign(events(), {
        statusCode: 200, headersSent: false, writableEnded: false, destroyed: false,
        setHeader(name, value) { headers.set(name, String(value)); },
        getHeader(name) { return headers.get(name); },
        writeHead(status, values = {}) { this.statusCode = status; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); this.headersSent = true; return this; },
        write(value) { if (!this.writableEnded && value != null) chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); return true; },
        end(value) { if (this.writableEnded) return; this.write(value); this.writableEnded = true; this.emit('finish'); },
      });
      const abort = () => { res.destroyed = true; res.emit('close'); req.emit('close'); };
      request.signal.addEventListener('abort', abort, { once: true });
      try {
        request.signal.throwIfAborted();
        await middlewares.handle(req, res, (_req, response) => { response.writeHead(404); response.end(); });
        request.signal.throwIfAborted();
        const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new Response([204, 205, 304].includes(res.statusCode) ? null : bytes, { status: res.statusCode, headers });
      } finally { request.signal.removeEventListener('abort', abort); }
    },
    close() { lifecycle.emit('close'); },
  };
}
