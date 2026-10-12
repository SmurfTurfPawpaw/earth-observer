/** Pure temporal and content identities shared by the scene and evidence lanes.
 * This module deliberately has no discovery, provider or domain dependencies. */
export function worldTime(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new TypeError('Use a valid UTC ISO timestamp');
  const at = new Date(value).toISOString();
  if (at.slice(0, 19) !== value.slice(0, 19)) throw new TypeError('Use a valid UTC calendar date');
  return at;
}

export const isWorldDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function worldHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
