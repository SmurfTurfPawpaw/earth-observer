import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readBoundedBody, inspectEvidenceJpeg, MAX_PHOTO_BYTES } from '../worker/evidence-policy.js';

export function moderationRequest(base, command, idOrCursor, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 || /[\r\n]/.test(secret)) throw new Error('Provide the moderation key through EARTH_MODERATION_KEY or standard input.');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS site URL, or HTTP localhost for development.');
  const root = `${url.origin}${url.pathname.replace(/\/$/, '')}/api/evidence/moderation`;
  const headers = { authorization: `Bearer ${secret}` };
  if (command === 'list') {
    if (idOrCursor && idOrCursor.length > 2048) throw new Error('The page cursor is too long.');
    return new Request(`${root}${idOrCursor ? `?cursor=${encodeURIComponent(idOrCursor)}` : ''}`, { headers, redirect: 'error' });
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(idOrCursor || '')) throw new Error('Use a submission reference returned by the review queue.');
  if (command === 'photo') return new Request(`${root}/${idOrCursor}/photo`, { headers, redirect: 'error' });
  if (!['approve', 'reject', 'unpublish'].includes(command)) throw new Error('Use list, photo, approve, reject or unpublish.');
  return new Request(`${root}/${idOrCursor}`, { method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: command }) });
}
export async function runModeration({ base, command, idOrCursor, secret, fetchImpl = fetch }) {
  const request = moderationRequest(base, command, idOrCursor, secret);
  const response = await fetchImpl(request, { signal: AbortSignal.timeout(15000) });
  const bytes = await readBoundedBody(response, command === 'photo' ? MAX_PHOTO_BYTES : 1024 * 1024);
  if (!response.ok) throw new Error(`The moderation service returned HTTP ${response.status}. No action was confirmed.`);
  if (command === 'photo') { if (response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') throw new Error('The service did not return a JPEG.'); inspectEvidenceJpeg(bytes); return bytes; }
  const text = new TextDecoder().decode(bytes);
  if (text.includes(secret)) throw new Error('The moderation service returned an unsafe response.');
  try { return JSON.parse(text); } catch { throw new Error('The moderation service returned an unreadable response.'); }
}
async function main() {
  const [base, command, idOrCursor, output, ...extra] = process.argv.slice(2);
  if (!base || base === '--help') {
    process.stdout.write('Usage: node scripts/evidence-moderate.mjs SITE_URL list [CURSOR]\n       node scripts/evidence-moderate.mjs SITE_URL photo REFERENCE OUTPUT.jpg\n       node scripts/evidence-moderate.mjs SITE_URL approve|reject|unpublish REFERENCE\nRead the key from EARTH_MODERATION_KEY, or pipe it into standard input. Never pass a key as a command argument.\n'); return;
  }
  if (extra.length || !['list', 'photo', 'approve', 'reject', 'unpublish'].includes(command) || command !== 'photo' && output || command === 'photo' && !output) throw new Error('Invalid arguments. Use --help for usage; do not put secrets in arguments.');
  let secret = process.env.EARTH_MODERATION_KEY;
  if (!secret) {
    if (process.stdin.isTTY) throw new Error('Set EARTH_MODERATION_KEY securely or supply it through standard input.');
    // A key is at most 256 characters; do not read an unbounded pipe into memory.
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 1024) throw new Error('Standard input exceeded the key limit.'); chunks.push(chunk); }
    secret = Buffer.concat(chunks).toString('utf8').trim();
  }
  const result = await runModeration({ base, command, idOrCursor, secret });
  if (command === 'photo') { await writeFile(output, result, { flag: 'wx' }); process.stdout.write('Pending photo saved locally for review. It has not been published.\n'); }
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Moderation command failed. Check the site URL, key configuration, reference and output file; no action was confirmed.\n'); process.exitCode = 1; });
