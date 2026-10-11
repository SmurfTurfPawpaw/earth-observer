import test from 'node:test';
import assert from 'node:assert/strict';
import { createEconomicsPanel, formatEconomicValue } from './economics.js';

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.attributes = {}; this.listeners = new Map(); this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}
function dom() {
  const document = { hidden: false, listeners: new Map(),
    createElement(tag) { return new Element(tag, this); },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
  };
  return { document, container: new Element('section', document) };
}
const body = (country = 'BEL', status = 'ready') => ({ status, frequency: 'annual', country: { id: country },
  retrievedAt: '2026-10-11T00:00:00Z', nextRefreshMs: 86400000,
  indicators: [{ id: 'NY.GDP.MKTP.CD', value: 10, year: 2024, history: [{ year: 2024, value: 10 }, { year: 2023, value: null }] }] });
const reply = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const textOf = (value) => typeof value === 'string' ? value : [value.textContent, ...value.children.map(textOf)].join(' ');

test('economic formatting preserves percentage units, negative growth and real zeroes', () => {
  assert.equal(formatEconomicValue(0, 'percent'), '0%');
  assert.equal(formatEconomicValue(150.25, 'percent'), '150.25%');
  assert.equal(formatEconomicValue(-2.5, 'percent'), '-2.5%');
  assert.equal(formatEconomicValue(null, 'integer'), 'Not available');
  assert.equal(formatEconomicValue(NaN, 'usd'), 'Not available');
  assert.equal(formatEconomicValue(1234, 'usd'), 'US$ 1,234');
});

test('economic panel loads on open only and reuses annual ready facts across close/open', async () => {
  const { document, container } = dom(); let calls = 0;
  const panel = createEconomicsPanel({ container, documentRef: document, country: 'BE', fetchImpl: async (url) => {
    calls++; assert.equal(url, '/api/economics?country=BEL'); return reply(body());
  } });
  assert.equal(calls, 0); assert.equal(container.hidden, true);
  await panel.refresh(); assert.equal(calls, 0);
  await panel.open(); assert.equal(calls, 1); assert.equal(container.hidden, false);
  assert.match(textOf(container), /Reference year 2024/);
  assert.match(textOf(container), /World Development Indicators/);
  assert.match(textOf(container), /Not available/);
  panel.close(); await panel.open(); assert.equal(calls, 1);
  panel.destroy(); assert.equal(container.children.length, 0); assert.equal(document.listeners.size, 0);
});

test('closing or changing country prevents a late response from publishing another economy', async () => {
  const { document, container } = dom(); const releases = new Map();
  const panel = createEconomicsPanel({ container, documentRef: document, country: 'BE', fetchImpl: (url) => new Promise((resolve) => { releases.set(url, resolve); }) });
  const be = panel.open();
  const us = panel.setCountry('US');
  releases.get('/api/economics?country=USA')(reply(body('USA'))); await us;
  releases.get('/api/economics?country=BEL')(reply(body('BEL'))); await be;
  assert.equal(panel.getState().payload.country.id, 'USA');
  const again = panel.refresh(true); panel.close();
  releases.get('/api/economics?country=USA')(reply({ ...body('USA'), retrievedAt: 'later' })); await again;
  assert.equal(panel.getState().payload.retrievedAt, '2026-10-11T00:00:00Z');
  assert.equal(panel.getState().opened, false);
});

test('stale and unavailable economics responses remain retryable and invalid timestamps are omitted safely', async () => {
  for (const status of ['stale', 'unavailable']) {
    const { document, container } = dom(); let calls = 0;
    const panel = createEconomicsPanel({ container, documentRef: document, country: 'BE', fetchImpl: async () => {
      calls++; return reply({ ...body('BEL', calls === 1 ? status : 'ready'), retrievedAt: 'invalid-date', reason: 'Provider temporarily unavailable' });
    } });
    await panel.open(); panel.close(); await panel.open();
    assert.equal(calls, 2); assert.equal(panel.getState().payload.status, 'ready');
    assert.doesNotMatch(textOf(container), /Invalid Date/);
  }
});

test('hidden economic panel cancels pending work and refreshes when visible again', async () => {
  const { document, container } = dom(); let calls = 0;
  const panel = createEconomicsPanel({ container, documentRef: document, country: 'BE', fetchImpl: async () => { calls++; return reply(body()); } });
  document.hidden = true; await panel.open(); assert.equal(calls, 0);
  document.hidden = false; document.listeners.get('visibilitychange')();
  await panel.refresh(); assert.equal(calls, 1);
});

test('economic browser copy retains storage age and receives its background revalidation', async () => {
  const { document, container } = dom(); let calls = 0, listener, unsubscribed = false;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ ...body(), indicators: [{ ...body().indicators[0], value: calls }] }),
      { headers: { 'Content-Type': 'application/json', 'x-browser-cache': calls === 1 ? 'STALE' : 'HIT', 'x-browser-cached-at': calls === 1 ? '1000' : '90000' } });
  };
  fetchImpl.subscribe = (callback) => { listener = callback; return () => { unsubscribed = true; }; };
  const panel = createEconomicsPanel({ container, documentRef: document, country: 'BE', now: () => 100000, fetchImpl });
  await panel.open(); assert.equal(panel.getState().refreshedAt, 1000); assert.equal(panel.getState().payload.status, 'stale');
  listener('http://localhost/api/economics?country=USA'); assert.equal(calls, 1);
  listener('http://localhost/api/economics?country=BEL'); await panel.refresh();
  assert.equal(calls, 2); assert.equal(panel.getState().refreshedAt, 90000); assert.equal(panel.getState().payload.indicators[0].value, 2);
  panel.close(); listener('http://localhost/api/economics?country=BEL'); assert.equal(calls, 2);
  panel.destroy(); assert.equal(unsubscribed, true);
});
