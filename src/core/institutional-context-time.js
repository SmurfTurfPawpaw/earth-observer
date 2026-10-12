import { worldTime } from './world-identity.js';

const canonical = value => {
  try { return worldTime(value) === value ? value : null; } catch { return null; }
};

/** A committed context snapshot, separate from the continuously advancing globe. */
export function institutionalContextTime(scene = {}, now = Date.now()) {
  if (scene.mode !== 'history') return { mode: 'live', lens: 'reconstruction', at: null, knownAt: null, available: true };
  const at = canonical(scene.at), lens = scene.lens === 'known-then' ? 'known-then' : 'reconstruction';
  const explanation = scene.lens != null && !['reconstruction', 'known-then'].includes(scene.lens) ? 'The historical evidence mode is unavailable. Choose Reconstruction or Platform knew then.'
    : !at ? 'A canonical historical UTC is unavailable. Choose a date or return to Live.'
    : Date.parse(at) > now ? 'Future institutional publications are unavailable. Return to Live for retained current sources.' : null;
  return { mode: 'history', lens, at, knownAt: lens === 'known-then' ? at : null, available: !explanation, explanation };
}

export const institutionalContextKey = (view, context) => JSON.stringify([view, context.mode, context.lens, context.at, context.available]);

export function institutionalContextUrl(base, context) {
  if (!context.available) return null;
  if (context.mode === 'live') return base;
  const url = new URL(base, 'https://context.invalid');
  url.searchParams.set('at', context.at);
  if (context.knownAt) url.searchParams.set('knownAt', context.knownAt);
  return url.pathname + url.search;
}

/** Publication time is not law-effective time. Knowledge is the hosted receipt cutoff. */
export function validateInstitutionalContextTime(payload, context) {
  if (context.mode !== 'history' || !payload.available) return payload;
  const before = (value, cutoff) => canonical(value) !== null && value <= cutoff;
  if (!context.available || !Array.isArray(payload.items) || payload.items.some(item => !before(item.publishedAt, context.at)))
    throw new Error('Stored publications do not match the selected publication UTC.');
  if (context.knownAt && (
    ![payload.receipt?.capturedAt, payload.receipt?.recordedAt].every(value => before(value, context.knownAt)) ||
    payload.items.some(item => ![item.firstRecordedAt, item.lastRecordedAt, item.evidence?.capturedAt, item.evidence?.recordedAt]
      .every(value => before(value, context.knownAt)))))
    throw new Error('Stored publication evidence exceeds the selected platform knowledge cutoff.');
  return payload;
}
