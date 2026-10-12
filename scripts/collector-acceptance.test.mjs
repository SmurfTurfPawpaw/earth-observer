import test from 'node:test';
import assert from 'node:assert/strict';
import { runCollectorAcceptance, COLLECTOR_ACCEPTANCE_LIMITS } from './collector-acceptance.mjs';

function fixture() {
  let elapsed = 0;
  const calls = [], messages = [], sleeps = [];
  return { calls, messages, sleeps, options: {
    key: 'k'.repeat(43), durationMinutes: 10, monotonicNow: () => elapsed,
    now: () => Date.parse('2026-10-12T00:00:00Z') + elapsed,
    sleepImpl: async ms => { sleeps.push(ms); elapsed += ms; },
    invoke: async args => { calls.push({ at: elapsed, args }); elapsed += 5000;
      return { ok: true, summary: { status: 'stored', stored: true, heartbeat: calls.length % 2 === 0, factualPublication: calls.length % 2 === 1 } }; },
    onAttempt: value => messages.push(value),
  } };
}

test('finite acceptance spaces fixed capability wakes, counts operational and factual acknowledgments, and reserves request budget before stopping', async () => {
  const f = fixture(), result = await runCollectorAcceptance(f.options);
  assert.equal(result.status, 'passed'); assert.equal(result.attempts, 9); assert.equal(result.successes, 9);
  assert.equal(result.factualPublications, 5); assert.equal(result.unchangedChecks, 4); assert.equal(result.stopReason, 'duration');
  for (let i = 1; i < f.calls.length; i++) assert.equal(f.calls[i].at - f.calls[i - 1].at, COLLECTOR_ACCEPTANCE_LIMITS.intervalMs);
  assert.ok(f.calls.every(call => call.args.timeoutMs === 55_000 && !('url' in call.args) && !('body' in call.args)));
  assert.ok(result.elapsedMs < 600_000); assert.equal(JSON.stringify(f.messages).includes(f.options.key), false);
});

test('failed capability acknowledgments back off within a finite trial and never create overlapping retries', async () => {
  const f = fixture(); f.options.durationMinutes = 30;
  f.options.invoke = async args => { f.calls.push({ at: f.options.monotonicNow(), args }); return { ok: false, summary: { status: 'busy', stored: false } }; };
  const result = await runCollectorAcceptance(f.options);
  assert.equal(result.status, 'incomplete'); assert.equal(result.attempts, 5);
  assert.deepEqual(f.sleeps, [61_000, 122_000, 244_000, 488_000]); assert.ok(result.elapsedMs < 1_800_000);
});

test('cancellation and missing configuration start no acquisition; cancellation after one result cannot renew the job', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await runCollectorAcceptance({ ...f.options, signal: controller.signal })).stopReason, 'cancelled'); assert.equal(f.calls.length, 0);
  assert.equal((await runCollectorAcceptance({ ...f.options, key: null })).status, 'unconfigured');
  const g = fixture(), stop = new AbortController();
  g.options.invoke = async args => { g.calls.push(args); stop.abort(); return { ok: true, summary: { status: 'stored', stored: true } }; };
  assert.equal((await runCollectorAcceptance({ ...g.options, signal: stop.signal })).attempts, 1); assert.equal(g.sleeps.length, 0);
  await assert.rejects(() => runCollectorAcceptance({ ...g.options, durationMinutes: 480 }), /reviewed/);
});
