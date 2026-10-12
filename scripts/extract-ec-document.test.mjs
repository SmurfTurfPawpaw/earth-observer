import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const python = process.env.EARTH_DOCUMENT_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
let present = true; try { await access(python); } catch { present = false; }
function execute(args, input = Buffer.alloc(0), holdInput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('TEST ONLY outer deadline')); }, 23000);
    child.on('error', reject); child.stdout.on('data', data => { length += data.length; if (length > 1048576) { child.kill(); reject(Error('Output budget')); } else chunks.push(data); });
    child.stderr.on('data', data => errors.push(data)); child.on('close', code => { clearTimeout(timer); child.stdin.destroy(); resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString() }); });
    child.stdin.on('error', () => {}); if (!holdInput) child.stdin.end(input);
  });
}
test('bundled external CLI preserves synthetic original bytes and has explicit local supervision', { skip: !present }, async () => {
  const generator = "import io,sys; from reportlab.pdfgen.canvas import Canvas; out=io.BytesIO(); c=Canvas(out); t=c.beginText(30,800); t.setFont('Helvetica',8); [t.textLine(s) for s in ['TEST ONLY synthetic citation fixture','European Commission - Statement','Statement on the International Criminal Court following announcement of US sanctions','Brussels, 9 October 2026','STATEMENT/26/2127']]; c.drawText(t); c.save(); sys.stdout.buffer.write(out.getvalue())";
  const generated = await execute(['-c', generator]); assert.equal(generated.code, 0);
  const result = await execute(['scripts/extract-ec-document.py', '--include-original'], generated.stdout); assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout); assert.deepEqual(Buffer.from(value.originalPdfBase64, 'base64'), generated.stdout);
  assert.equal(value.extraction.inputMode, 'stdin'); assert.equal(value.extraction.acquiredAt, null);
  assert.equal(value.extraction.runtime.peakMemoryEnforced, false); assert.equal(value.extraction.runtime.wallTimeSeconds, 20);
  assert.equal(value.extraction.pages.length, 1); assert.equal(value.extraction.extractor.offsetUnit, 'unicode-code-points');
});
test('parent wall-time bound stops a blocked stdin producer and emits no success artifact', { skip: !present }, async () => {
  const started = Date.now(), result = await execute(['scripts/extract-ec-document.py'], undefined, true);
  assert.notEqual(result.code, 0); assert.equal(result.stdout.length, 0);
  assert.ok(Date.now() - started >= 19000 && Date.now() - started < 22500);
});
test('CLI rejects malformed/oversized PDF input and arbitrary source/path arguments with no success artifact', { skip: !present }, async () => {
  for (const [args, input] of [[[], Buffer.from('not a PDF')], [[], Buffer.alloc(524289)], [['--url=https://evil.example'], Buffer.alloc(0)],
    [['--child'], Buffer.alloc(0)]]) {
    const result = await execute(['scripts/extract-ec-document.py', ...args], input); assert.notEqual(result.code, 0); assert.equal(result.stdout.length, 0);
  }
});
