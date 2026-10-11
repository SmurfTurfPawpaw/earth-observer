import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  CCTV_MAX_SOURCES_CEILING,
  DEFAULT_FINTRAFFIC_MAX_SOURCES,
  DEFAULT_NSW_MAX_SOURCES,
  DEFAULT_CALGARY_MAX_SOURCES,
  DEFAULT_VEGVESEN_MAX_SOURCES,
  DRIVEBC_WEBCAMS_URL,
} from '../../server/providers/cctv/constants.js';
import {
  driveBcImageCredit,
  loadDriveBcSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** A DriveBC `/api/webcams/` row carrying the fields the loader reads. */
function driveBcRow(id, lat, lon, overrides = {}) {
  return {
    id,
    name: `Camera ${id}`,
    is_on: true,
    should_appear: true,
    region_name: 'Lower Mainland',
    orientation: 'N',
    elevation: 12,
    location: { type: 'Point', coordinates: [lon, lat] },
    links: { imageDisplay: `/images/${id}.jpg?t=1` },
    ...overrides,
  };
}

test('DriveBC loader keeps reviewed published cameras and builds frame URLs from the camera id', async (t) => {
  quiet(t);
  withEnv(t, {
    CCTV_DRIVEBC_MAX_SOURCES: undefined,
    CCTV_DRIVEBC_TERMS_ACCEPTED: '1',
    CCTV_DRIVEBC_APPROVED_IDS: '13,682,1,2,3,4,5,6,7',
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      driveBcRow(13, 49.001268, -122.756658, {
        name: 'Douglas (Peace Arch) Border Crossing',
        region_name: 'Border Cams',
        elevation: 10,
        // The payload's own link is ignored; frames come from the pinned host.
        links: { imageDisplay: 'https://example.com/13.jpg' },
      }),
      driveBcRow(682, 49.0579, -123.0569, {
        orientation: 'se',
        elevation: null,
        credit:
          'Images courtesy of <a href="https://www.translink.ca/" target="_blank">TransLink</a>',
      }),
      driveBcRow(1, 49.2, -123.1, { is_on: false }),
      driveBcRow(2, 49.2, -123.1, { should_appear: false }),
      driveBcRow('3', 49.2, -123.1),
      driveBcRow(4, null, -123.1),
      driveBcRow(5, 49.2, -123.1, { location: null }),
      driveBcRow(6, 1000, -123.1),
      driveBcRow(7, 34.05, -118.24),
      driveBcRow(999, 49.2, -123.1), // valid but not reviewed: excluded
    ]);
  });

  const cameras = await loadDriveBcSourcesFromOpenData();

  assert.deepEqual(requested, [DRIVEBC_WEBCAMS_URL]);
  // Nearest to the Vancouver anchor first: the pack is always distance-sorted
  // so the catalog-wide cap thins it from the far end.
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['drivebc-682', 'drivebc-13'],
  );
  const border = cameras.find((camera) => camera.id === 'drivebc-13');
  const deltaport = cameras.find((camera) => camera.id === 'drivebc-682');
  assert.equal(border.url, 'https://www.drivebc.ca/images/13.jpg');
  assert.equal(border.snapshotUrl, border.url);
  assert.equal(border.name, 'Douglas (Peace Arch) Border Crossing');
  assert.equal(border.city, 'BC Border');
  assert.equal(border.provider, 'DriveBC');
  assert.equal(border.feedType, 'image');
  assert.equal(border.headingDeg, 0);
  assert.equal(border.headingConfidence, 'high');
  assert.equal(border.groundElevationM, 10);
  assert.match(border.license, /Open Government Licence – British Columbia/);
  assert.equal(
    border.credit,
    '',
    'a provincial camera carries no partner credit',
  );
  assert.equal(
    deltaport.credit,
    'Images courtesy of TransLink',
    'a partner-supplied camera names its owner, HTML stripped',
  );
  assert.equal(deltaport.city, 'Lower Mainland');
  assert.equal(
    deltaport.headingDeg,
    135,
    'orientation codes are case-insensitive',
  );
  assert.equal(
    deltaport.groundElevationM,
    0,
    'a missing elevation falls back to sea level',
  );
});

test('DriveBC loader keeps the cameras nearest Vancouver and Victoria under its cap', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_DRIVEBC_MAX_SOURCES: '8', CCTV_DRIVEBC_TERMS_ACCEPTED: '1' });
  const rows = [
    // Fort Nelson rows come first in payload order, so only distance can drop them.
    ...[58.8, 58.81, 58.82, 58.83].map((lat, i) =>
      driveBcRow(100 + i, lat, -122.7),
    ),
    ...[49.28, 49.27, 49.26, 49.25].map((lat, i) =>
      driveBcRow(200 + i, lat, -123.12),
    ),
    ...[48.43, 48.44, 48.45, 48.46].map((lat, i) =>
      driveBcRow(300 + i, lat, -123.37),
    ),
  ];
  withEnv(t, { CCTV_DRIVEBC_APPROVED_IDS: rows.map((row) => row.id).join(',') });
  t.mock.method(globalThis, 'fetch', async () => Response.json(rows));

  const cameras = await loadDriveBcSourcesFromOpenData();

  assert.equal(cameras.length, 8);
  assert.deepEqual(
    cameras
      .map((camera) => camera.id)
      .filter((id) => /^drivebc-10\d$/.test(id)),
    [],
    'the northern cameras are the ones dropped',
  );
});

test('DriveBC loader fails soft on HTTP errors, unexpected payloads and network errors', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_DRIVEBC_TERMS_ACCEPTED: '1', CCTV_DRIVEBC_APPROVED_IDS: '13' });
  let respond;
  const fetchMock = t.mock.method(globalThis, 'fetch', (...args) => respond(...args));
  for (respond of [
    async () => new Response('unavailable', { status: 503 }),
    async () => Response.json({ webcams: [] }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(await loadDriveBcSourcesFromOpenData(), []);
  }
  assert.equal(fetchMock.mock.callCount(), 3, 'failure paths actually fetch the configured provider');
});

test('CCTV catalog merges DriveBC cameras and CCTV_DRIVEBC_ENABLED=0 skips the request', async (t) => {
  quiet(t);
  withEnv(t, {
    CCTV_MAX_SOURCES: undefined,
    CCTV_FINTRAFFIC_ENABLED: '1',
    CCTV_NSW_ENABLED: '1',
    CCTV_CALGARY_ENABLED: '1',
    CCTV_VEGVESEN_ENABLED: '1',
    CCTV_TFL_ENABLED: '0',
    CCTV_ONTARIO_ENABLED: '0',
    CCTV_DRIVEBC_ENABLED: '1',
    CCTV_DRIVEBC_MAX_SOURCES: undefined,
    CCTV_DRIVEBC_TERMS_ACCEPTED: '1',
    CCTV_DRIVEBC_APPROVED_IDS: '13',
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only DriveBC answers.
    return String(url) === DRIVEBC_WEBCAMS_URL
      ? Response.json([driveBcRow(13, 49.001268, -122.756658)])
      : new Response('unavailable', { status: 503 });
  });

  const sources = await createCctvCatalog()();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['drivebc-13'],
  );
  assert.equal(sources[0].url, 'https://www.drivebc.ca/images/13.jpg');

  process.env.CCTV_DRIVEBC_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog()(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.includes(DRIVEBC_WEBCAMS_URL),
    false,
    'a disabled pack makes no request',
  );
});

test('default per-pack camera caps fit inside the default catalog cap', () => {
  // Only the four reviewed, ungated camera providers are enabled by default.
  const packs =
    DEFAULT_FINTRAFFIC_MAX_SOURCES +
    DEFAULT_NSW_MAX_SOURCES +
    DEFAULT_CALGARY_MAX_SOURCES +
    DEFAULT_VEGVESEN_MAX_SOURCES;
  assert.ok(
    packs <= DEFAULT_CCTV_MAX_SOURCES,
    `default packs (${packs}) would be thinned by the catalog cap (${DEFAULT_CCTV_MAX_SOURCES})`,
  );
  assert.ok(
    DEFAULT_CCTV_MAX_SOURCES <= CCTV_MAX_SOURCES_CEILING,
    'the default cap must sit inside the CCTV_MAX_SOURCES ceiling',
  );
});

test('DriveBC credit keeps partner attribution and drops operational notes', () => {
  assert.equal(
    driveBcImageCredit(
      'Images courtesy of <a href="https://x.test/">TransLink</a>',
    ),
    'Images courtesy of TransLink',
  );
  assert.equal(
    driveBcImageCredit('Camera image provided by City of Vancouver'),
    'Camera image provided by City of Vancouver',
  );
  assert.equal(
    driveBcImageCredit(
      'BC HighwayCam presented in cooperation with AtkinsRéalis.',
    ),
    'BC HighwayCam presented in cooperation with AtkinsRéalis.',
  );
  assert.equal(
    driveBcImageCredit(
      'This camera is located in a remote area and relies on solar power. As a result, transmission delays may occur.',
    ),
    '',
  );
  assert.equal(driveBcImageCredit(null), '');
});
