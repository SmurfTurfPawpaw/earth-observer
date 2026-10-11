import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSIT_ENABLED_FEEDS, getTransitFeed, publicTransitCatalog, transitFeedsInRange } from '../../src/data/transitFeeds.js';
import { GBFS_CITY_REGISTRY } from '../../src/layers/bikeshare/registry.js';
import { isAllowedGbfsUrl } from '../../src/data/gbfsSource.js';
import { LAYER_BY_ID } from '../../src/core/catalog.js';
import { gbfsProxy } from './gbfs.js';
import { CCTV_PROVIDER_PACKS, createCctvCatalog, enabledCctvProviderNames } from './cctv/catalog.js';
import { loadDriveBcSourcesFromOpenData, loadOntarioSourcesFromOpenData, loadTflSourcesFromOpenData } from './cctv/sources.js';
import { cctvProxy, fetchCctvImageFromUpstream } from './cctv.js';

const policy = JSON.parse(readFileSync(new URL('../../src/core/provider-policy.json', import.meta.url)));
const providerEnv = (value) => Object.fromEntries(CCTV_PROVIDER_PACKS.map((pack) => [`CCTV_${pack.name.toUpperCase()}_ENABLED`, value]));

function withEnv(t, changes) {
  for (const [name, value] of Object.entries(changes)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

function captureMiddleware(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(_path, middleware) { handler = middleware; } } });
  return async (url) => {
    const response = {};
    await handler({ method: 'GET', url }, {
      writeHead(status, headers) { Object.assign(response, { status, headers }); },
      end(body) { response.body = body; },
    });
    return response;
  };
}

test('disabled transit feeds cannot resolve through catalog, route or coverage helpers', () => {
  assert.deepEqual(TRANSIT_ENABLED_FEEDS.map((feed) => feed.id), policy.transit.allowed);
  assert.deepEqual(publicTransitCatalog().map((feed) => feed.id), policy.transit.allowed);
  for (const id of [...policy.transit.excluded, ...policy.transit.configured, 'unknown-feed']) assert.equal(getTransitFeed(id), null);
  assert.equal(transitFeedsInRange(44.9778, -93.265).some((feed) => feed.id === 'metrotransit-msp'), false);
  assert.equal(transitFeedsInRange(-27.4698, 153.0251).some((feed) => feed.id === 'translink-seq'), false);
});

test('GBFS allows only reviewed systems, including on an otherwise approved host', async (t) => {
  assert.deepEqual(GBFS_CITY_REGISTRY.map((entry) => entry.id), policy.bikeshare.allowed);
  const approved = GBFS_CITY_REGISTRY[0].stationStatusUrl;
  assert.equal(isAllowedGbfsUrl(approved), true);
  const blocked = [approved.replace('/bkn/', '/bay/'), `${approved}?system=bay`, `${approved}#other-system`,
    approved.replace('https://', 'https://user:password@'), approved.replace('gbfs.lyft.com', 'unknown.publicbikesystem.net')];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return Response.json({ data: { stations: [] } }); });
  const request = captureMiddleware(gbfsProxy());
  for (const url of blocked) {
    assert.equal(isAllowedGbfsUrl(url), false);
    assert.equal((await request(`/${encodeURIComponent(url)}`)).status, 403);
  }
  assert.equal(requests, 0);
  assert.equal((await request(`/${encodeURIComponent(approved)}`)).status, 200);
  assert.equal(requests, 1);
});

test('CCTV ignores custom inputs and immediately revokes cached providers and IDs', async (t) => {
  withEnv(t, { ...providerEnv(undefined),
    CCTV_DRIVEBC_TERMS_ACCEPTED: undefined, CCTV_DRIVEBC_APPROVED_IDS: undefined,
    CCTV_TFL_TERMS_ACCEPTED: undefined, TFL_APP_KEY: undefined,
    CCTV_ONTARIO_TERMS_ACCEPTED: undefined, ONTARIO_511_API_KEY: undefined,
    CCTV_SOURCES_JSON: JSON.stringify([{ id: 'custom', url: 'https://unlicensed.example/frame.jpg' }]),
    CCTV_SOURCES_FILE: 'unlicensed-camera-file.json',
  });
  assert.deepEqual(enabledCctvProviderNames(), policy.cctv.allowed);
  for (const pack of CCTV_PROVIDER_PACKS) t.mock.method(pack, 'load', async () => [
    { id: `${pack.name}-13`, lat: 49, lon: -123, url: 'https://approved.example/frame.jpg' },
    ...(pack.name === 'drivebc' ? [{ id: 'drivebc-14', lat: 49, lon: -123 }] : []),
  ]);
  const catalog = createCctvCatalog();
  assert.deepEqual((await catalog()).map((source) => source.pack), policy.cctv.allowed);
  process.env.CCTV_FINTRAFFIC_ENABLED = '0';
  assert.equal((await catalog()).some((source) => source.pack === 'fintraffic'), false);
  process.env.CCTV_DRIVEBC_TERMS_ACCEPTED = '1'; process.env.CCTV_DRIVEBC_APPROVED_IDS = '13,14';
  const configured = createCctvCatalog();
  assert.equal((await configured()).filter((source) => source.pack === 'drivebc').length, 2);
  process.env.CCTV_DRIVEBC_APPROVED_IDS = '14';
  assert.deepEqual((await configured()).filter((source) => source.pack === 'drivebc').map((source) => source.id), ['drivebc-14']);
  process.env.CCTV_DRIVEBC_TERMS_ACCEPTED = '0';
  assert.equal((await configured()).some((source) => source.pack === 'drivebc'), false);
});

test('DriveBC reviews are per ID and Ontario registration keys stay server side', async (t) => {
  withEnv(t, { CCTV_DRIVEBC_TERMS_ACCEPTED: '1', CCTV_DRIVEBC_APPROVED_IDS: '13',
    CCTV_ONTARIO_TERMS_ACCEPTED: '1', ONTARIO_511_API_KEY: undefined });
  t.mock.method(console, 'log', () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    if (String(url).includes('511on.ca')) return Response.json([]);
    return Response.json([13, 14].map((id) => ({ id, name: `Camera ${id}`, is_on: true, should_appear: true,
      region_name: 'Lower Mainland', orientation: 'N', elevation: 12, location: { type: 'Point', coordinates: [-123.1, 49.2] } })));
  });
  assert.deepEqual(await loadOntarioSourcesFromOpenData(), []);
  assert.equal(requests.length, 0);
  assert.deepEqual((await loadDriveBcSourcesFromOpenData()).map((source) => source.id), ['drivebc-13']);
  process.env.ONTARIO_511_API_KEY = 'test-registration-key';
  await loadOntarioSourcesFromOpenData();
  assert.equal(requests.at(-1).searchParams.get('key'), 'test-registration-key');
});

test('CCTV credentials alone do not satisfy registration terms gates', async (t) => {
  withEnv(t, { ...providerEnv('0'), CCTV_TFL_ENABLED: '1', CCTV_ONTARIO_ENABLED: '1',
    TFL_APP_KEY: 'test-key', ONTARIO_511_API_KEY: 'test-key',
    CCTV_TFL_TERMS_ACCEPTED: undefined, CCTV_ONTARIO_TERMS_ACCEPTED: undefined });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return Response.json([]); });
  assert.deepEqual(enabledCctvProviderNames(), []);
  assert.deepEqual(await loadTflSourcesFromOpenData(), []);
  assert.deepEqual(await loadOntarioSourcesFromOpenData(), []);
  assert.equal(requests, 0);
});

test('approved displays preserve prescribed ECMWF and registered TfL notices', async (t) => {
  const wind = LAYER_BY_ID.get('wind');
  assert.match(wind.detailedAttribution, /This service is based on data and products of the European Centre for Medium-Range Weather Forecasts \(ECMWF\)/);
  assert.match(wind.detailedAttribution, /href="https:\/\/www\.ecmwf\.int\//);
  assert.match(wind.detailedAttribution, /href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/"/);
  assert.match(wind.detailedAttribution, /Modified: resampled forecast wind, temperature and pressure fields/);
  assert.match(wind.detailedAttribution, /ECMWF does not accept any liability/);

  withEnv(t, { ...providerEnv('0'), CCTV_TFL_ENABLED: '1', CCTV_TFL_TERMS_ACCEPTED: '1', TFL_APP_KEY: 'registered-test-key' });
  t.mock.method(console, 'log', () => {});
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests += 1;
    assert.equal(new URL(url).searchParams.get('app_key'), 'registered-test-key');
    return Response.json([{ id: 'JamCams_00002.00865', commonName: 'London test camera', lat: 51.5, lon: -0.12,
      additionalProperties: [{ key: 'available', value: 'true' },
        { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg' }] }]);
  });
  const request = captureMiddleware(cctvProxy());
  const { sources } = JSON.parse((await request('/sources')).body);
  assert.equal(sources.length, 1); assert.equal(requests, 1);
  assert.equal(sources[0].license, 'Powered by TfL Open Data');
  assert.match(sources[0].credit, /Contains OS data © Crown copyright and database rights 2016/);
  assert.match(sources[0].credit, /Geomni UK Map data © and database rights \[2019\]/);
  assert.match(sources[0].credit, /https:\/\/tfl\.gov\.uk\/corporate\/terms-and-conditions\/transport-data-service/);
});

test('CCTV frame admission, cache coalescing and revocation share the approved catalog', async (t) => {
  withEnv(t, { ...providerEnv('0'), CCTV_FINTRAFFIC_ENABLED: '1' });
  t.mock.method(CCTV_PROVIDER_PACKS[0], 'load', async () => [{ id: 'fintraffic-C0150301', name: 'Test road', lat: 60.1, lon: 24.9,
    url: 'https://weathercam.digitraffic.fi/C0150301.jpg', license: 'CC BY 4.0' }]);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests += 1; assert.equal(options.redirect, 'manual');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  });
  const request = captureMiddleware(cctvProxy());
  const catalog = JSON.parse((await request('/sources')).body);
  assert.equal(catalog.sources[0].frameUrl, '/api/cctv/frame/fintraffic-C0150301');
  assert.equal(catalog.sources[0].url, undefined); assert.equal(catalog.sources[0].snapshotUrl, undefined);
  assert.equal((await request('/frame/unregistered?url=https://unlicensed.example/image.jpg')).status, 404);
  assert.equal(requests, 0);
  const frames = await Promise.all([request('/frame/fintraffic-C0150301'), request('/media/fintraffic-C0150301')]);
  assert.deepEqual(frames.map((frame) => frame.status), [200, 200]); assert.equal(requests, 1);
  assert.equal((await request('/frame/fintraffic-C0150301?ts=123')).status, 200); assert.equal(requests, 1);
  assert.equal((await request('/media/fintraffic-C0150301/seg_1.ts')).status, 404);
  process.env.CCTV_FINTRAFFIC_ENABLED = '0';
  assert.equal((await request('/frame/fintraffic-C0150301')).status, 404);
  assert.deepEqual(JSON.parse((await request('/health')).body).cameras, []); assert.equal(requests, 1);
});

test('CCTV refuses credentials, off-provider URLs, redirects and oversized image streams', async () => {
  const url = 'https://weathercam.digitraffic.fi/C0150301.jpg';
  let requests = 0;
  const forbiddenFetch = async () => { requests += 1; throw new Error('Unexpected fetch'); };
  for (const target of ['https://unlicensed.example/image.jpg', url.replace('https://', 'https://user:password@'), url.replace('https://', 'http://')])
    assert.equal(await fetchCctvImageFromUpstream(target, { provider: 'fintraffic', fetchImpl: forbiddenFetch }), null);
  assert.equal(await fetchCctvImageFromUpstream(url, { provider: 'calgary', fetchImpl: forbiddenFetch }), null); assert.equal(requests, 0);
  assert.equal(await fetchCctvImageFromUpstream(url, { provider: 'fintraffic', fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  } }), null);
  let cancelled = false;
  assert.equal(await fetchCctvImageFromUpstream(url, { provider: 'fintraffic', maxBytes: 4,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/jpeg' } }),
  }), null);
  assert.equal(cancelled, true);
});
