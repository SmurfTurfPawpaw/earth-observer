import { showSavedScene } from './core/scene-preview.js';
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
      const engine = document.createElement('script');
      engine.src = preload.href;
      engine.id = 'cesium-engine';
      engine.async = true;
      const label = document.querySelector('#loading p');
      if (label) label.textContent = 'Loading the 3D engine…';
      await new Promise((resolve, reject) => {
        engine.addEventListener('load', resolve, { once: true });
        engine.addEventListener('error', () => reject(new Error('The 3D engine could not download. Reload to try again.')), { once: true });
        document.head.append(engine);
      });
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
