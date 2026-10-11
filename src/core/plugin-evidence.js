/** Deterministic JSON and hashes shared by reviewed typed source plugins. */
export function pluginJson(value) {
  function canonical(input, depth) {
    if (depth > 32) throw new TypeError('Plugin evidence exceeds its nesting bound');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => canonical(item, depth + 1));
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype)
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key], depth + 1)]));
    throw new TypeError('Plugin evidence must contain finite JSON values');
  }
  return JSON.stringify(canonical(value, 0));
}

export async function pluginBytesDigest(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Hash original plugin bytes');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const pluginFactsDigest = value => pluginBytesDigest(new TextEncoder().encode(pluginJson(value)));
