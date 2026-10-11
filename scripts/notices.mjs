import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party software distributed with Earth Observer.\nData terms are in DATA_POLICY.md.'];
for (const folder of Object.keys(lock.packages).sort()) {
  if (!folder.startsWith('node_modules/')) continue;
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')); } catch { continue; }
  notices.push(`\n\n===== ${pkg.name} ${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'see license'}) =====`);
  for (const filename of await readdir(folder)) {
    if (/^(?:licen[cs]e|notice|copying|authors)(?:[.\-_].*)?$/i.test(filename)) {
      try { notices.push(`\n${filename}\n${await readFile(path.join(folder, filename), 'utf8')}`); } catch {}
    }
  }
}
const text = notices.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
await writeFile('public/THIRD_PARTY_LICENSES.txt', `${text}\n`);
