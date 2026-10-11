export const DOCUMENT_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    // Cesium's bundled Knockout widgets and decoder workers require these.
    "script-src 'self' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss: ws:",
    "worker-src 'self' blob:",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
