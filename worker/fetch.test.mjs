import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerFetch } from './fetch.js';
import { createEarthRuntime } from './index.js';

function workerdFetch(respond, calls) {
  return async (input, init) => {
    calls.push({ input, init });
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    if (redirect === 'error') throw new TypeError('Invalid redirect value, must be follow or manual');
    return respond(input, init);
  };
}

test('Worker fetch translates rejected native error mode without mutating reusable options', async () => {
  const calls = [], response = new Response('observations');
  const signal = new AbortController().signal, headers = Object.freeze({ Accept: 'application/json' });
  const init = Object.freeze({ redirect: 'error', signal, headers });
  const native = workerdFetch(() => response, calls);
  await assert.rejects(native('https://source.example/data', init), TypeError);
  const fetchImpl = createWorkerFetch(native);
  assert.equal(await fetchImpl('https://source.example/data', init), response);
  assert.equal(init.redirect, 'error');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(calls[1].init.signal, signal); assert.equal(calls[1].init.headers, headers);
  assert.notEqual(calls[1].init, init);
});

test('Worker fetch refuses only real redirects, cancels their bodies and never follows Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let cancelled = false;
    const calls = [], body = new ReadableStream({ cancel() { cancelled = true; } });
    const fetchImpl = createWorkerFetch(workerdFetch(() => new Response(body, {
      status, headers: { Location: 'https://unreviewed.example/private?token=sensitive' },
    }), calls));
    await assert.rejects(fetchImpl('https://approved.example/data', { redirect: 'error' }),
      (error) => error instanceof TypeError && error.message === 'Upstream redirect refused');
    assert.equal(cancelled, true); assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'https://approved.example/data');
  }
  const notModified = new Response(null, { status: 304 });
  assert.equal(await createWorkerFetch(async () => notModified)('https://source.example/data', { redirect: 'error' }), notModified);
});

test('redirect body cancellation failure still refuses the response', async () => {
  const body = new ReadableStream({ cancel() { throw new Error('Storage unavailable'); } });
  const fetchImpl = createWorkerFetch(async () => new Response(body, { status: 302 }));
  await assert.rejects(fetchImpl('https://source.example/data', { redirect: 'error' }), /Upstream redirect refused/);
});

test('Worker fetch inherits Request redirect policy and leaves explicit follow/manual unchanged', async () => {
  const calls = [], response = new Response('data'), fetchImpl = createWorkerFetch(workerdFetch(() => response, calls));
  const input = new Request('https://source.example/data', { redirect: 'error' });
  assert.equal(await fetchImpl(input), response); assert.equal(calls[0].input, input);
  assert.equal(calls[0].init.redirect, 'manual'); assert.equal(input.redirect, 'error');
  for (const init of [undefined, { redirect: 'follow' }, { redirect: 'manual' }]) {
    assert.equal(await fetchImpl('https://source.example/data', init), response);
    assert.equal(calls.at(-1).init, init);
  }
  const follow = Object.freeze({ redirect: 'follow' });
  assert.equal(await fetchImpl(input, follow), response); assert.equal(calls.at(-1).init, follow);
});

test('runtime routes economics, aircraft, launches and context through the Worker-safe adapter', async () => {
  const calls = [], clock = Date.parse('2026-10-11T00:00:00Z');
  const economy = [{ page: 1, pages: 1, total: 1, sourceid: null },
    [{ indicator: { id: 'NY.GDP.MKTP.CD' }, countryiso3code: 'BEL', date: '2025', value: 123 }]];
  const runtime = createEarthRuntime({ now: () => clock, cache: null,
    fetchImpl: workerdFetch((input) => {
      const url = String(input);
      if (url.includes('api.worldbank.org')) return Response.json(economy);
      if (url.includes('api.adsb.lol')) return Response.json({ ac: [{ hex: '123abc', lat: 4, lon: 5 }] });
      if (url.includes('ll.thespacedevs.com')) return Response.json({ results: [] });
      if (url.includes('context.example')) return Response.json({ elements: [] });
      throw new Error('Unexpected source');
    }, calls) });
  const get = (path) => runtime.fetch(new Request(`https://example.com/earth/api/${path}`),
    { OVERPASS_UPSTREAMS: 'https://context.example/api/interpreter' });
  const facts = await (await get('economics?country=BE')).json(); assert.equal(facts.status, 'ready');
  const aircraft = await (await get('flights?lat=4&lon=5')).json(); assert.equal(aircraft.ac[0].hex, '123abc');
  const launches = await get('launches'); assert.equal(launches.status, 200);
  const context = await runtime.fetch(new Request('https://example.com/earth/api/overpass', { method: 'POST',
    body: new URLSearchParams({ data: '[out:json];node["amenity"="bicycle_parking"](around:100,4,5);out body;' }).toString() }));
  assert.equal(context.status, 200);
  assert.equal(calls.length, 4); assert.ok(calls.every((call) => call.init.redirect === 'manual'));
  runtime.close();
});
