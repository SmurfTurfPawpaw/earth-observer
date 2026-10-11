import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimPointer,
  isLeaseCurrent,
  isPointerFree,
  isPointerOwnedBy,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from './inputOwnership.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test.beforeEach(() => resetPointerOwnership());

test('the pointer starts free and a claim hands back a lease', () => {
  assert.equal(isPointerFree(), true);
  assert.equal(pointerOwner(), null);

  const lease = claimPointer('draw');
  assert.ok(lease, 'a successful claim returns a lease, not a boolean');
  assert.equal(isPointerFree(), false);
  assert.equal(pointerOwner(), 'draw');
  assert.equal(isPointerOwnedBy('draw'), true);
  assert.equal(isPointerOwnedBy('directions'), false);
  assert.equal(isLeaseCurrent(lease), true);
});

test('a claim is never stolen — not even by the same tool name', () => {
  const first = claimPointer('draw');
  assert.ok(first);

  assert.equal(
    claimPointer('directions'),
    null,
    'another tool must not displace it',
  );
  assert.equal(
    claimPointer('draw'),
    null,
    'a SECOND instance of the same tool is a second owner, not a no-op',
  );
  assert.equal(pointerOwner(), 'draw');
  assert.equal(isLeaseCurrent(first), true);
});

test('a replaced instance cannot free its successor’s claim', () => {
  // The bug this rule exists for. An old Draw instance is torn down while a new
  // one is already running; the old teardown calls releasePointer. Under
  // release-by-name that freed the LIVE claim and every layer started selecting
  // through the new instance's vertices.
  const stale = claimPointer('draw');
  assert.ok(releasePointer(stale), 'the old instance gives the pointer back');

  const live = claimPointer('draw');
  assert.ok(live, 'the replacement takes it');
  assert.notEqual(live.id, stale.id, 'a fresh claim is a fresh lease');

  assert.equal(releasePointer(stale), false, 'the stale lease frees nothing');
  assert.equal(pointerOwner(), 'draw', 'the replacement still holds it');
  assert.equal(isLeaseCurrent(stale), false);
  assert.equal(isLeaseCurrent(live), true);

  assert.equal(releasePointer(live), true);
  assert.equal(isPointerFree(), true);
});

test('release ignores anything that is not the live lease', () => {
  const lease = claimPointer('draw');
  for (const bad of [
    null,
    undefined,
    'draw',
    {},
    { owner: 'draw', id: lease.id + 99 },
  ]) {
    assert.equal(releasePointer(bad), false, JSON.stringify(bad));
    assert.equal(pointerOwner(), 'draw');
  }
  assert.equal(releasePointer(lease), true);
  assert.equal(releasePointer(lease), false, 'releasing twice changes nothing');
});

test('a claim needs a real owner id', () => {
  for (const bad of ['', '   ', null, undefined, 7, {}]) {
    assert.equal(claimPointer(bad), null, JSON.stringify(bad));
    assert.equal(isPointerFree(), true);
  }
  const lease = claimPointer('  draw  ');
  assert.ok(lease, 'ids are trimmed, not rejected for padding');
  assert.equal(pointerOwner(), 'draw');
  assert.equal(releasePointer(lease), true);
});

test('reset reports who was holding it, for teardown', () => {
  assert.equal(resetPointerOwnership(), null);
  const lease = claimPointer('draw');
  assert.equal(resetPointerOwnership(), 'draw');
  assert.equal(isPointerFree(), true);
  assert.equal(isLeaseCurrent(lease), false);
});
