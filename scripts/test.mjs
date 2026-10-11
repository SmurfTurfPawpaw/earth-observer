import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function tests(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? tests(file) : /\.test\.mjs$/.test(entry.name) ? [file] : [];
  }))).flat();
}
const files = [...await tests('src'), ...await tests('server')].sort();
const child = spawn(process.execPath, ['--test', '--test-concurrency=4', ...files], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
