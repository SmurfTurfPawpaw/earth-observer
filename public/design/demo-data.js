// Fictional fixtures for the separate design prototype. These are not live news.
export const DEMO_NOW = Date.UTC(2026, 9, 12, 12);
export const DEMO_START = DEMO_NOW - 7 * 24 * 60 * 60 * 1000;

export const demoCategories = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'natural', label: 'Natural' },
  { id: 'politics', label: 'Politics' },
  { id: 'economy', label: 'Economy' },
  { id: 'mobility', label: 'Mobility' },
].map(Object.freeze));

const hour = 60 * 60 * 1000;
const fixtureSource = (label, type) => ({
  label,
  type,
  note: 'Fictional source fixture for this design demonstration. No live report or external source is implied.',
});

function event({ id, category, kind, headline, place, country, lon, lat, ageHours, summary, development, source }) {
  const occurredAt = DEMO_NOW - ageHours * hour;
  return {
    id: `demo:${id}`,
    category,
    kind,
    symbol: kind,
    headline,
    place,
    country,
    lon,
    lat,
    occurredAt,
    ageHours,
    summary,
    status: 'Sample report',
    simulated: true,
    locationMeaning: 'Illustrative location; not a verified event coordinate.',
    updates: [
      { at: occurredAt, text: 'First sample report appears in the demonstration.' },
      { at: Math.min(DEMO_NOW, occurredAt + hour / 2), text: development },
    ],
    sources: [fixtureSource(source, 'Sample bulletin'), fixtureSource('Demo contextual note', 'Design fixture')],
  };
}

export const demoEvents = deepFreeze([
  event({ id: 'osaka-seismic', category: 'natural', kind: 'earthquake', headline: 'Seismic report near Osaka', place: 'Osaka', country: 'Japan', lon: 135.502, lat: 34.694, ageHours: 1, summary: 'An M4.7 seismic report places the event near Osaka. A revised bulletin adds depth information; local impacts have not been reported.', development: 'The sample bulletin adds magnitude and depth context. Consequences remain unassessed.', source: 'Demo geological bulletin' }),
  event({ id: 'riga-consultations', category: 'politics', kind: 'politics', headline: 'Regional consultations in Riga', place: 'Riga', country: 'Latvia', lon: 24.105, lat: 56.949, ageHours: 4, summary: 'Regional representatives meet in Riga for consultations. A joint statement sets out topics for a second round of talks.', development: 'A fictional joint statement announces another meeting. No causal forecast is attached.', source: 'Demo institutional statement' }),
  event({ id: 'brussels-transit', category: 'mobility', kind: 'transport', headline: 'Tram diversion in central Brussels', place: 'Brussels', country: 'Belgium', lon: 4.352, lat: 50.847, ageHours: 12, summary: 'A central tram route is temporarily diverted for maintenance. Passengers are directed to nearby alternative stops.', development: 'The sample transport notice provides a diversion window and an alternative stop.', source: 'Demo city transport notice' }),
  event({ id: 'rotterdam-energy', category: 'economy', kind: 'energy', headline: 'Energy terminal update in Rotterdam', place: 'Rotterdam', country: 'Netherlands', lon: 4.479, lat: 51.924, ageHours: 18, summary: 'A terminal operations note revises an energy-handling window. The update outlines reporting dates and linked logistics activity.', development: 'The invented operator update clarifies its reporting window. No price or supply forecast is inferred.', source: 'Demo terminal operations note' }),
  event({ id: 'dhaka-flood', category: 'natural', kind: 'flood', headline: 'River-level notice near Dhaka', place: 'Dhaka', country: 'Bangladesh', lon: 90.413, lat: 23.810, ageHours: 30, summary: 'River gauges near Dhaka show a rising water level. Monitoring teams issue an advisory while the affected area remains unclear.', development: 'A sample monitoring note adds an observation time. The extent of flooding is unknown.', source: 'Demo hydrological bulletin' }),
  event({ id: 'santiago-seismic', category: 'natural', kind: 'earthquake', headline: 'Seismic observation near Santiago', place: 'Santiago', country: 'Chile', lon: -70.669, lat: -33.449, ageHours: 42, summary: 'A seismic bulletin records an event near Santiago. A later revision adjusts the reported depth while retaining the original event time.', development: 'The sample revision adjusts the reported depth while preserving the original report time.', source: 'Demo seismic revision' }),
  event({ id: 'geneva-dialogue', category: 'politics', kind: 'politics', headline: 'Dialogue session convenes in Geneva', place: 'Geneva', country: 'Switzerland', lon: 6.143, lat: 46.204, ageHours: 54, summary: 'Delegates meet in Geneva for a dialogue session. The published agenda identifies topics for a follow-up meeting.', development: 'A fictional agenda lists the subjects discussed. No outcome is assumed.', source: 'Demo conference agenda' }),
  event({ id: 'lagos-power', category: 'economy', kind: 'energy', headline: 'Grid maintenance notice in Lagos', place: 'Lagos', country: 'Nigeria', lon: 3.379, lat: 6.524, ageHours: 70, summary: 'A grid operator schedules maintenance in Lagos. A revised notice narrows the service window and outlines arrangements for affected areas.', development: 'The fictional notice narrows the maintenance window. Actual grid performance is not represented.', source: 'Demo grid operator notice' }),
  event({ id: 'singapore-freight', category: 'mobility', kind: 'transport', headline: 'Freight schedule update in Singapore', place: 'Singapore', country: 'Singapore', lon: 103.820, lat: 1.352, ageHours: 83, summary: 'A freight operator revises a departure window in Singapore. The update separates the new schedule from the original plan.', development: 'The sample carrier note confirms a revised departure window.', source: 'Demo freight schedule' }),
  event({ id: 'porto-alegre-water', category: 'natural', kind: 'flood', headline: 'Water-level advisory near Porto Alegre', place: 'Porto Alegre', country: 'Brazil', lon: -51.230, lat: -30.035, ageHours: 95, summary: 'River monitoring teams issue a water-level advisory near Porto Alegre. A municipal update adds observations as monitoring continues.', development: 'A sample municipal note adds monitoring context without a damage estimate.', source: 'Demo water monitoring note' }),
  event({ id: 'antwerp-energy', category: 'economy', kind: 'energy', headline: 'Energy logistics note in Antwerp', place: 'Antwerp', country: 'Belgium', lon: 4.402, lat: 51.219, ageHours: 108, summary: 'An energy logistics briefing is published in Antwerp. It outlines terminal handling arrangements and the schedule for a further update.', development: 'The sample note identifies a logistics dependency. It makes no statement about current Belgian imports.', source: 'Demo logistics briefing' }),
  event({ id: 'nairobi-bus', category: 'mobility', kind: 'transport', headline: 'Bus route diversion in Nairobi', place: 'Nairobi', country: 'Kenya', lon: 36.822, lat: -1.292, ageHours: 122, summary: 'Road works prompt a temporary bus diversion in Nairobi. An updated service notice lists alternative stops and an expected return window.', development: 'The fictional transit update adds the expected return to the usual route.', source: 'Demo bus service notice' }),
  event({ id: 'ottawa-policy', category: 'politics', kind: 'politics', headline: 'Policy briefing published in Ottawa', place: 'Ottawa', country: 'Canada', lon: -75.697, lat: 45.422, ageHours: 137, summary: 'A policy briefing sets out priorities for a public consultation in Ottawa. An accompanying appendix adds the proposed timetable.', development: 'A sample appendix provides further context without corroborating another sample story.', source: 'Demo public policy briefing' }),
  event({ id: 'cologne-river', category: 'natural', kind: 'flood', headline: 'River monitoring update in Cologne', place: 'Cologne', country: 'Germany', lon: 6.960, lat: 50.938, ageHours: 149, summary: 'Monitoring teams publish a river-level update in Cologne. A second measurement is added while observations along the river continue.', development: 'The sample update records a second measurement. No interpolated water level is shown.', source: 'Demo river monitoring bulletin' }),
  event({ id: 'los-angeles-port', category: 'mobility', kind: 'transport', headline: 'Port access update in Los Angeles', place: 'Los Angeles', country: 'United States', lon: -118.244, lat: 34.052, ageHours: 158, summary: 'A port access notice revises an entry window in Los Angeles. The update gives operators a new time period for scheduled access.', development: 'The invented notice adds a revised access period.', source: 'Demo port access notice' }),
  event({ id: 'wellington-seismic', category: 'natural', kind: 'earthquake', headline: 'Seismic report near Wellington', place: 'Wellington', country: 'New Zealand', lon: 174.777, lat: -41.287, ageHours: 165, summary: 'A seismic bulletin records an event near Wellington. A follow-up report adds observation details while local effects remain unknown.', development: 'The fictional bulletin adds source context. No aftershock prediction is provided.', source: 'Demo geological observation' }),
]);

export const demoRelationships = deepFreeze([
  { id: 'demo:energy-corridor', from: 'demo:rotterdam-energy', to: 'demo:antwerp-energy', category: 'economy', label: 'Simulated energy logistics context', note: 'Simulated logistics relationship between two fictional energy notes. Not an observed shipment or actual supply dependency.', simulated: true },
  { id: 'demo:institutional-context', from: 'demo:geneva-dialogue', to: 'demo:riga-consultations', category: 'politics', label: 'Simulated institutional context', note: 'Simulated thematic context between fictional institutional stories. Not a causal or independently corroborated link.', simulated: true },
  { id: 'demo:freight-scenario', from: 'demo:singapore-freight', to: 'demo:los-angeles-port', category: 'mobility', label: 'Simulated freight connection', note: 'Fictional connection for the visual design scenario. Not an observed vessel route, shipment or real freight dependency.', simulated: true },
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
