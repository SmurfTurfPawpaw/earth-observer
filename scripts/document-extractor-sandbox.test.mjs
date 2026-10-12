import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PYTHON = process.env.EARTH_DOCUMENT_PYTHON || 'C:/Users/schak/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const SCRIPT = fileURLToPath(new URL('./document-extractor-sandbox.py', import.meta.url));
const SKIP = process.platform !== 'win32' || !existsSync(PYTHON) ? 'requires the reviewed Windows bundled Python runtime' : false;
const MIB = 1024 * 1024;

function execute(args, input = Buffer.alloc(0), { holdInput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', '-B', ...args], { windowsHide: true,
      env: { ...process.env, EARTH_FAKE_PRODUCER_SECRET: 'test-only-must-not-reach-parser' } });
    const stdout = [], stderr = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Outer test execution deadline')); }, 6000);
    child.on('error', reject);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * MIB) { child.kill(); reject(new Error('Outer test output bound')); } else stdout.push(chunk); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > 2 * MIB) { child.kill(); reject(new Error('Outer test output bound')); } else stderr.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); child.stdin.destroy(); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
    if (!holdInput) child.stdin.end(input);
  });
}

async function job(code, overrides = {}, input = '') {
  const config = JSON.stringify({ code, overrides, input });
  const source = `import json,runpy,sys
m=runpy.run_path(${JSON.stringify(SCRIPT)})
c=json.loads(${JSON.stringify(config)})
try:
 r=m['run_in_job']([sys.executable,'-I','-B','-c',c['code']],c['input'].encode(),m['Limits'](**c['overrides']))
 print(json.dumps({'ok':True,'stdout':r['stdout'].decode(),'stderr':r['stderr'].decode(),'execution':r['execution']}))
except m['BoundedExecutionError'] as e:
 print(json.dumps({'ok':False,'error':e.code,'execution':e.execution}))`;
  const result = await execute(['-c', source]);
  assert.equal(result.code, 0, result.stderr.toString());
  return JSON.parse(result.stdout);
}

function bounded(execution, processBytes = 64 * MIB, jobBytes = 96 * MIB) {
  assert.equal(execution.mode, 'windows-job-object');
  assert.equal(execution.memoryMeaning, 'committed-virtual-memory');
  assert.equal(execution.processMemoryLimitBytes, processBytes);
  assert.equal(execution.jobMemoryLimitBytes, jobBytes);
  assert.equal(execution.jobListAppliedBeforeExecution, true);
  assert.equal(execution.activeProcessesAfterCleanup, 0);
  // Native accounting can include a denied allocation's attempted peak. The
  // enforcement proof is quota readback + allocation denial, not peak<=quota.
  assert.ok(Number.isSafeInteger(execution.nativeReportedPeakProcessBytes));
  assert.ok(Number.isSafeInteger(execution.nativeReportedPeakJobBytes));
  assert.ok(execution.nativeReportedPeakProcessBytes <= 128 * MIB);
  assert.ok(execution.nativeReportedPeakJobBytes <= 128 * MIB);
}

test('native pre-execution job assignment and accounting work under the current host with no inherited producer secret', { skip: SKIP }, async () => {
  const result = await job("import json,os; print(json.dumps({'ok':True,'secretLeaked':'EARTH_FAKE_PRODUCER_SECRET' in os.environ}))");
  assert.equal(result.ok, true); bounded(result.execution);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, secretLeaked: false });
});

test('nonfinite or nonnumeric internal deadlines are rejected before native launch', { skip: SKIP }, async () => {
  const source = `import json,runpy,sys
m=runpy.run_path(${JSON.stringify(SCRIPT)})
codes=[]
for value in [float('nan'),float('inf'),float('-inf'),True,'invalid']:
 try:
  m['run_in_job']([sys.executable,'-I','-B','-c',"print('must-not-launch')"],deadline=value)
 except m['BoundedExecutionError'] as e:
  codes.append(e.code)
print(json.dumps(codes))`;
  const result = await execute(['-c', source]); assert.equal(result.code, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout), Array(5).fill('invalid-deadline'));
});

test('kernel denies oversized process allocation before Python postchecks can accept it', { skip: SKIP }, async () => {
  // Requested allocation is 96 MiB, with a 32 MiB per-process commit cap.
  const result = await job("value=bytearray(96*1024*1024); print('must-not-succeed')", {
    process_memory_bytes: 32 * MIB, job_memory_bytes: 48 * MIB,
  });
  assert.equal(result.ok, false); assert.equal(result.error, 'process-failed');
  assert.equal('stdout' in result, false); bounded(result.execution, 32 * MIB, 48 * MIB);
});

test('aggregate job memory denies two individually admissible 32MiB allocations', { skip: SKIP }, async () => {
  const code = `import json,subprocess,sys
held=bytearray(32*1024*1024)
child=subprocess.run([sys.executable,'-I','-B','-c','held=bytearray(32*1024*1024)'],capture_output=True)
print(json.dumps({'childFailed':child.returncode!=0,'allocationDenied':b'MemoryError' in child.stderr}))`;
  const result = await job(code, { process_memory_bytes: 64 * MIB, job_memory_bytes: 64 * MIB });
  assert.equal(result.ok, true); bounded(result.execution, 64 * MIB, 64 * MIB);
  assert.deepEqual(JSON.parse(result.stdout), { childFailed: true, allocationDenied: true });
});

test('process-count limit rejects a third process and root exit cleans up its sleeping descendant', { skip: SKIP }, async () => {
  const code = `import json,subprocess,sys
child=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])
denied=False
try:
 extra=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])
except OSError:
 denied=True
print(json.dumps({'denied':denied,'childPid':child.pid}),flush=True)`;
  const before = Date.now(), result = await job(code);
  assert.equal(result.ok, true); bounded(result.execution);
  assert.equal(JSON.parse(result.stdout).denied, true);
  assert.ok(Date.now() - before < 2500, 'cleanup must not wait for the sixty-second descendant');
});

test('wall-clock and output violations terminate the full job and expose no success output', { skip: SKIP }, async () => {
  const before = Date.now(), slow = await job('import time; time.sleep(60)', { wall_seconds: 0.25 });
  assert.equal(slow.ok, false); assert.equal(slow.error, 'wall-deadline'); assert.equal('stdout' in slow, false);
  bounded(slow.execution); assert.ok(Date.now() - before < 2500);
  for (const stream of [1, 2]) {
    const overflowing = await job(`import os; os.write(${stream},b'x'*65536)`, { stdout_bytes: 4096, stderr_bytes: 4096 });
    assert.equal(overflowing.ok, false); assert.equal(overflowing.error, 'output-limit'); assert.equal('stdout' in overflowing, false);
    bounded(overflowing.execution);
  }
});

test('input reader stops oversized or stalled binary pipes before launching a parser', { skip: SKIP }, async () => {
  const oversized = await execute([SCRIPT], Buffer.alloc(512 * 1024 + 1));
  assert.notEqual(oversized.code, 0); assert.equal(oversized.stdout.length, 0);
  const source = `import runpy,time
m=runpy.run_path(${JSON.stringify(SCRIPT)})
try:
 m['read_bounded_stdin'](10,time.monotonic()+0.2)
except m['BoundedExecutionError'] as e:
 print(e.code)`;
  const before = Date.now(), stalled = await execute(['-c', source], undefined, { holdInput: true });
  assert.equal(stalled.stdout.toString().trim(), 'stdin-deadline'); assert.ok(Date.now() - before < 1500);
  const inputLimit = await job("print('must-not-launch')", { input_bytes: 4 }, '12345');
  assert.equal(inputLimit.ok, false); assert.equal(inputLimit.error, 'input-limit'); assert.equal(inputLimit.execution, null);
});

test('fixed extractor receives original synthetic bytes under verified bounds; arbitrary fetch/path arguments fail closed', { skip: SKIP }, async () => {
  const generate = `import io,sys
from reportlab.pdfgen import canvas
b=io.BytesIO();c=canvas.Canvas(b)
for y,text in [(790,'European Commission - Statement'),(770,'Statement on the International Criminal Court following announcement of US sanctions'),(750,'Brussels, 9 October 2026'),(730,'STATEMENT/26/2127')]:
 c.drawString(20,y,text)
c.save();sys.stdout.buffer.write(b.getvalue())`;
  const fixture = await execute(['-c', generate]); assert.equal(fixture.code, 0, fixture.stderr.toString());
  const result = await execute([SCRIPT, '--include-original'], fixture.stdout);
  assert.equal(result.code, 0, result.stderr.toString());
  const envelope = JSON.parse(result.stdout); bounded(envelope.execution);
  assert.equal(envelope.result.extraction.inputMode, 'stdin'); assert.equal(envelope.result.extraction.acquiredAt, null);
  assert.equal(envelope.result.extraction.runtime.peakMemoryEnforced, false, 'frozen inner contract is not silently rewritten');
  assert.deepEqual(Buffer.from(envelope.result.originalPdfBase64, 'base64'), fixture.stdout);
  for (const args of [['--fetch'], ['https://example.com/doc.pdf'], ['--command', 'anything']]) {
    const invalid = await execute([SCRIPT, ...args]); assert.notEqual(invalid.code, 0); assert.equal(invalid.stdout.length, 0);
  }
});
