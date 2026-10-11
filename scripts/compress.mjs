import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';

const gzipAsync = promisify(gzip), brotliAsync = promisify(brotliCompress);
const extensions = new Set(['.html', '.js', '.css', '.json', '.svg', '.geojson', '.geojsonl', '.md', '.txt', '.xml']);
const root = path.resolve('dist');
if (!(await stat(root)).isDirectory()) throw new Error('Build dist/ before compression');
const files = [];
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (extensions.has(path.extname(filename))) files.push(filename);
  }
}
await walk(root);
let count = 0, originalBytes = 0, brotliBytes = 0;
async function worker() {
  while (files.length) {
    const filename = files.pop();
    const bytes = await readFile(filename);
    if (bytes.length < 1024) continue;
    const [gz, br] = await Promise.all([
      gzipAsync(bytes, { level: 9 }),
      brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }),
    ]);
    if (gz.length < bytes.length) await writeFile(filename + '.gz', gz);
    if (br.length < bytes.length) await writeFile(filename + '.br', br);
    count++; originalBytes += bytes.length; brotliBytes += Math.min(br.length, bytes.length);
  }
}
await Promise.all([worker(), worker()]);
console.log(`Precompressed ${count} text assets: ${(originalBytes / 1048576).toFixed(1)} MiB → ${(brotliBytes / 1048576).toFixed(1)} MiB over Brotli.`);
