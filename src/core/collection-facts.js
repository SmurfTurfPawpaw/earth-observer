import { canonicalDiscoveryRecord } from './discovery-index.js';

/** Shared portable factual boundary. Only the acquisition clock is excluded. */
export function collectionFactsEncoding(records) {
  if (!Array.isArray(records) || records.length > 500) throw new TypeError('Invalid metadata bounds');
  const canonical = records.map(canonicalDiscoveryRecord);
  if (canonical.some(record => !record) || new Set(canonical.map(record => record.id)).size !== canonical.length)
    throw new TypeError('Invalid canonical metadata');
  canonical.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify(canonical.map(({ retrievedAt: _retrievedAt, ...facts }) => facts));
}

export async function collectionFactsDigest(records) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(collectionFactsEncoding(records)));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
