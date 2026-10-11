import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { hostedProviders } from './server/hosted/providers.js';
import { DOCUMENT_HEADERS } from './server/hosted/headers.js';
import { readFileSync } from 'node:fs';

const cesiumVersion = JSON.parse(readFileSync(new URL('./node_modules/cesium/package.json', import.meta.url), 'utf8')).version;
const stagedEngine = {
  name: 'nonblocking-globe-engine',
  apply: 'build',
  transformIndexHtml: { order: 'post', handler(html) {
    return html.replace(/<script\b[^>]*\bsrc="([^"]*\/Cesium\.js)"[^>]*><\/script>/,
      '<link rel="preload" as="script" href="$1" data-globe-engine>');
  } },
};

export default defineConfig({
  plugins: [cesium({ cesiumBaseUrl: `cesium/${cesiumVersion}/`, devMinifyCesium: true }), stagedEngine, ...hostedProviders()],
  server: { host: 'localhost', port: 4174, headers: DOCUMENT_HEADERS,
    fs: { deny: ['.env', '.env.*', '**/.git/**'] } },
  preview: { host: 'localhost', port: 4174, headers: DOCUMENT_HEADERS },
  build: { chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: (id) => id.includes('/node_modules/@cesium/') || id.includes('/node_modules/cesium/') ? 'cesium' : undefined } } },
});
