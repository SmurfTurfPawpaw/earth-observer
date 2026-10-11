/** Mount the same provider handlers in Vite and the production HTTP server. */
export function createMiddlewareStack() {
  const handlers = [];
  return {
    use(path, handler) {
      if (typeof path === 'function') [path, handler] = ['', path];
      if (typeof handler !== 'function') throw new TypeError('Middleware must be a function');
      handlers.push({ path, handler });
    },
    async handle(req, res, fallback) {
      async function dispatch(index) {
        if (res.writableEnded) return;
        const entry = handlers[index];
        if (!entry) return fallback(req, res);
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (entry.path && pathname !== entry.path && !pathname.startsWith(entry.path + '/'))
          return dispatch(index + 1);
        const originalUrl = req.url;
        if (entry.path) req.url = req.url.slice(entry.path.length) || '/';
        if (req.url.startsWith('?')) req.url = '/' + req.url;
        let nextPromise;
        let called = false;
        const next = (error) => {
          if (called) return nextPromise;
          called = true;
          req.url = originalUrl;
          nextPromise = error ? Promise.reject(error) : dispatch(index + 1);
          return nextPromise;
        };
        try {
          await entry.handler(req, res, next);
          await nextPromise;
        } finally {
          req.url = originalUrl;
        }
      }
      await dispatch(0);
    },
  };
}
