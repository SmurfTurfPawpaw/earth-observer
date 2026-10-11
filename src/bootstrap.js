import { showSavedScene } from './core/scene-preview.js';
import { loadEngineScript } from './bootstrap-engine.js';
// The worker reports actual network fallback; observations retain their own source times.
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type !== 'earth-observer:shell-status' || typeof event.data.message !== 'string') return;
  const notice = document.getElementById('notification');
  if (notice) { notice.textContent = event.data.message; notice.hidden = false; }
});
navigator.serviceWorker?.controller?.postMessage({ type: 'earth-observer:shell-status' });
/** Paint saved view and static controls while the essential 3D engine downloads. */
async function boot() {
  void showSavedScene();
  try {
    if (import.meta.env.PROD && !globalThis.Cesium) {
      const preload = document.querySelector('link[data-globe-engine]');
      if (!preload) throw new Error('The 3D engine script is missing.');
      const label = document.querySelector('#loading p');
      if (label) label.textContent = 'Loading the 3D engine…';
      await loadEngineScript({ src: preload.href });
    }
    const label = document.querySelector('#loading p');
    if (label) label.textContent = 'Opening the globe…';
    await import('./main.js');
  } catch (error) {
    document.getElementById('loading').hidden = true;
    document.getElementById('error').hidden = false;
    document.getElementById('error-message').textContent = error.message;
    document.getElementById('reload').addEventListener('click', () => location.reload(), { once: true });
    console.error('Earth Observer could not load:', error);
  }
}
boot();
