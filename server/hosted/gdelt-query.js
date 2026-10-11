const TOPICS = {
  disasters: ['earthquake', 'flood', 'cyclone', 'wildfire', 'disaster', 'volcano'],
  geopolitics: ['diplomacy', 'election', 'conflict', 'ceasefire', 'sanctions'],
  economy: ['trade', 'economy', 'tariffs', 'inflation', 'shipping'],
};

export function gdeltQueryUrl(filters) {
  const terms = filters.category === 'all' ? Object.values(TOPICS).flat() : TOPICS[filters.category];
  if (!terms) throw new TypeError('Unknown GDELT discovery category');
  let query = `(${terms.join(' OR ')})`;
  if (filters.countryName) query += ` "${filters.countryName.replace(/"/g, '')}"`;
  if (filters.q) query += ` "${filters.q.replace(/'/g, '')}"`;
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.search = new URLSearchParams({ query, mode: 'artlist', format: 'json', maxrecords: '80', timespan: '24h', sort: 'datedesc' });
  return url.href;
}
