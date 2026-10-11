/** Finite reviewed choices for aggregate demand; never extend this catalog from visitor text. */
export const DEMAND_PRODUCTION_ORIGINS = Object.freeze([
  'https://giovannicallebaut.com', 'https://www.giovannicallebaut.com',
]);
export const DEMAND_CATEGORIES = Object.freeze(['all', 'geopolitics', 'economy', 'disasters']);
// Mirrors the reviewed economics country catalog. JG (combined Channel Islands)
// and WLD are not country codes; XK is the explicitly supported Kosovo code.
export const DEMAND_COUNTRIES = Object.freeze(`
AD AE AF AG AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FO FR GA GB GD GE GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NZ OM PA PE PF PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TZ UA UG US UY UZ VC VE VG VI VN VU WS XK YE ZA ZM ZW
`.trim().split(/\s+/));
const THEMES = [
  ['ARMEDCONFLICT', 'geopolitics', 'Armed conflict'], ['ELECTION', 'geopolitics', 'Elections'],
  ['SANCTIONS', 'geopolitics', 'Sanctions'], ['NEGOTIATIONS', 'geopolitics', 'Negotiations'],
  ['ALLIANCE', 'geopolitics', 'Alliances'], ['BORDER', 'geopolitics', 'Borders'],
  ['PROTEST', 'geopolitics', 'Protests'], ['MILITARY', 'geopolitics', 'Military'],
  ['WB_2473_DIPLOMACY_AND_NEGOTIATIONS', 'geopolitics', 'Diplomacy'],
  ['WB_2462_POLITICAL_VIOLENCE_AND_WAR', 'geopolitics', 'Political violence and war'],
  ['WB_698_TRADE', 'economy', 'Trade'], ['EPU_ECONOMY', 'economy', 'Economy'],
  ['ECON_INFLATION', 'economy', 'Inflation'], ['ECON_STOCKMARKET', 'economy', 'Stock markets'],
  ['ECON_INTEREST_RATES', 'economy', 'Interest rates'], ['ECON_OILPRICE', 'economy', 'Oil prices'],
  ['ECON_CURRENCY_EXCHANGE_RATE', 'economy', 'Exchange rates'], ['ECON_DEBT', 'economy', 'Debt'],
  ['WB_793_TRANSPORT_AND_LOGISTICS_SERVICES', 'economy', 'Transport and logistics'],
  ['WB_471_ECONOMIC_GROWTH', 'economy', 'Economic growth'],
  ['NATURAL_DISASTER', 'disasters', 'Natural disasters'], ['DISASTER_FIRE', 'disasters', 'Fires'],
  ['MANMADE_DISASTER', 'disasters', 'Human-caused disasters'], ['EVACUATION', 'disasters', 'Evacuations'],
  ['HEALTH_PANDEMIC', 'disasters', 'Pandemics'],
  ['WB_2166_HEALTH_EMERGENCY_PREPAREDNESS_AND_DISASTER_RESPONSE', 'disasters', 'Emergency response'],
];
export const DEMAND_SUBJECTS = Object.freeze([
  { id: 'overview:all', label: 'All topics', category: 'all', kind: 'overview' },
  { id: 'overview:country', label: 'Country overview', category: 'all', kind: 'country-overview' },
  { id: 'category:geopolitics', label: 'Geopolitics', category: 'geopolitics', kind: 'category' },
  { id: 'category:economy', label: 'Economics & trade', category: 'economy', kind: 'category' },
  { id: 'category:disasters', label: 'Disasters', category: 'disasters', kind: 'category' },
  ...THEMES.map(([theme, category, label]) => ({ id: `gkg:${theme}`, theme, category, label, kind: 'theme' })),
].map(Object.freeze));
const subjects = new Map(DEMAND_SUBJECTS.map((subject) => [subject.id, subject]));
const countries = new Set(DEMAND_COUNTRIES);
const normalized = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const queries = new Map(DEMAND_SUBJECTS.filter((subject) => subject.theme).flatMap((subject) => [
  [normalized(subject.label), subject], [normalized(subject.theme), subject],
]));
export const demandSubject = (id) => subjects.get(id) || null;
export const isDemandCountry = (country) => country === '' || countries.has(country);
export const isDemandProductionOrigin = (origin) => DEMAND_PRODUCTION_ORIGINS.includes(origin);

/** A publisher, sentence, partial match, raw query or invalid filter produces no payload. */
export function reviewedDemandSearch(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const category = filters.category === undefined ? 'all' : filters.category;
  const country = filters.country === undefined ? '' : filters.country;
  const query = filters.q === undefined ? '' : filters.q;
  if (!DEMAND_CATEGORIES.includes(category) || typeof country !== 'string' || country.length > 8 || typeof query !== 'string' || query.length > 128) return null;
  const code = country.trim().toUpperCase();
  if (!isDemandCountry(code)) return null;
  const text = normalized(query);
  let subject;
  if (text) {
    subject = queries.get(text);
    if (!subject || category !== 'all' && subject.category !== category) return null;
  } else subject = subjects.get(category === 'all' ? code ? 'overview:country' : 'overview:all' : `category:${category}`);
  return { subjectId: subject.id, country: code, consent: true };
}
