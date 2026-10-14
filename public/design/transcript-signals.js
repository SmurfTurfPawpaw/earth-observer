/** Browser-local lexical passage selection. Input is source data, never instructions. */
const MAX_CHARACTERS = 200_000;
const MAX_SEGMENTS = 4_000;
const MAX_TIMESTAMP = 86_400;
const MAX_EXCERPT = 700;
const TOPICS = [
  {
    id: 'economics', title: 'Compute economics',
    clues: [[/\b(?:cost|price|dollars?)\s+per\s+(?:tokens?|cores?|query|queries)\b/, 6], [/\btokens?\s+per\s+second\b/, 5], [/\bunit\s+(?:cost|economics)\b/, 5], [/\bthroughput\b/, 4], [/\btokens?\b/, 3], [/\b(?:revenue|margin|moneti[sz]ation|economics)\b/, 3], [/\b(?:costs?|prices?|rent|rented|sell|selling|generate)\b/, 2]],
    meaning: 'Candidate passage about compute output, cost or commercial incentives. Compare the unit being discussed before drawing conclusions about profitability.',
    question: 'Which operating unit actually determines the economics here?',
    verify: ['Check whether the passage compares like-for-like workloads, costs and measurement periods.', 'Compare the stated economics with published pricing, operating costs or financial disclosures.'],
  },
  {
    id: 'infrastructure', title: 'Infrastructure constraints',
    clues: [[/\bliquid\s+cool(?:ed|ing)\b/, 6], [/\b(?:energy|power)\s+grid\b/, 6], [/\bdata\s+cent(?:er|re)s?\b/, 3], [/\bcooling\b/, 4], [/\b(?:assembl(?:y|e|ed|ing)|manufactur(?:e|ed|ing))\b/, 3], [/\b(?:power|energy|electricity|reliability|reliable)\b/, 2], [/\b(?:cables?|hoses?|rack|racks)\b/, 2]],
    meaning: 'Candidate passage about the physical requirements of computing. A design claim can suggest an operational constraint, but does not establish deployed performance.',
    question: 'What physical requirement limits deployment, and how would we measure it?',
    verify: ['Check the exact equipment generation and whether the described system is demonstrated or deployed.', 'Look for measured power, cooling, assembly or reliability figures under comparable conditions.'],
  },
  {
    id: 'supply', title: 'Supply and production',
    clues: [[/\bhigh\s+bandwidth\s+memory\b/, 6], [/\b(?:supply\s+chains?|intellectual\s+property)\b/, 5], [/\b(?:foundr(?:y|ies)|yields?|hbm|lpddr)\b/, 4], [/\bmemory\b/, 3], [/\b(?:capacity|suppl(?:y|ies)|production|bandwidth|availability)\b/, 2], [/\b(?:semiconductors?|fabrication|packaging)\b/, 3]],
    meaning: 'Candidate passage about components, capacity or production dependencies. Mentioning a constraint is a useful research lead, not proof of a current shortage.',
    question: 'Which component or production step is the limiting dependency?',
    verify: ['Check component specifications, production dates and the speaker’s intended product or market.', 'Compare capacity or shortage claims with supplier disclosures and an independent industry source.'],
  },
  {
    id: 'policy', title: 'Policy and market access',
    clues: [[/\bexport\s+(?:controls?|restrictions?|bans?)\b/, 6], [/\b(?:sanctions?|tariffs?|regulations?|regulatory)\b/, 5], [/\b(?:licen[cs]es?|licensing|legislation|polic(?:y|ies))\b/, 3], [/\bmarket\s+access\b/, 5], [/\bmarkets?\b/, 2], [/\b(?:government|rules|restrictions?)\b/, 2]],
    meaning: 'Candidate passage about rules or market access. Statements about policy need the actual rule, jurisdiction and effective date before being treated as present conditions.',
    question: 'Which rule changes access, and who is actually affected?',
    verify: ['Find the original policy document and check its jurisdiction, effective dates and exceptions.', 'Separate the speaker’s expectation from a rule that has already taken effect.'],
  },
  {
    id: 'strategy', title: 'Ecosystems and leverage',
    clues: [[/\b(?:installed\s+base|switching\s+costs?)\b/, 6], [/\b(?:partners?|partnerships?|ecosystems?)\b/, 4], [/\b(?:standards?|moats?|cuda|integration)\b/, 3], [/\b(?:platforms?|developers?|customers?|competit(?:ion|ors?))\b/, 2], [/\b(?:alliances?|distribution|interoperability)\b/, 4]],
    meaning: 'Candidate passage about partnerships, platforms or strategic dependencies. A relationship may warrant investigation without establishing durable advantage or intent.',
    question: 'What makes this relationship valuable, and what would make it replaceable?',
    verify: ['Check whether the relationship is contractual, technical, commercial or simply mentioned in conversation.', 'Look for alternatives, interoperability and evidence of switching costs before inferring strategic leverage.'],
  },
];

function leadingTimestamp(value) {
  const match = /^\s*(?:(\d{1,3}):([0-5]\d):([0-5]\d)|(\d{1,4}):([0-5]\d))(?!:)/.exec(String(value || ''));
  if (!match) return null;
  const at = match[1] !== undefined
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number(match[4]) * 60 + Number(match[5]);
  return at < MAX_TIMESTAMP ? { at, length: match[0].length } : null;
}

/** Read an explicit leading hh:mm:ss or m:ss; copied duration suffixes are ignored. */
export function parseTimestamp(value) {
  return leadingTimestamp(value)?.at ?? null;
}

function stripCopiedDuration(value, at) {
  let rest = value;
  const expected = { hour: Math.floor(at / 3600), minute: Math.floor(at / 60) % 60, second: at % 60 };
  // m:ss also permits total minutes above 59, as ordinary long-video timestamps do.
  const totalMinutes = Math.floor(at / 60);
  let previous = -1;
  for (let count = 0; count < 3; count++) {
    const match = /^\s*(\d{1,5})\s*(hours?|minutes?|seconds?)\s*(?:,\s*)?/i.exec(rest);
    if (!match) break;
    const unit = match[2].toLowerCase().replace(/s$/, ''), order = ['hour', 'minute', 'second'].indexOf(unit);
    const number = Number(match[1]);
    if (order <= previous || (number !== expected[unit] && !(unit === 'minute' && previous < 0 && number === totalMinutes))) break;
    rest = rest.slice(match[0].length); previous = order;
  }
  return rest.trim();
}

const clean = value => value.replace(/\s+/g, ' ').trim();
const normalized = value => clean(value.normalize('NFKC').toLowerCase());
const score = (value, topic) => {
  const passage = normalized(value);
  return topic.clues.reduce((sum, [pattern, weight]) => sum + (pattern.test(passage) ? weight : 0), 0);
};

function splitPassage(value) {
  const chunks = [];
  let rest = value;
  while (rest.length > 350) {
    const preview = rest.slice(0, 351), sentences = [...preview.matchAll(/[.!?](?=\s)/g)];
    const sentence = sentences.at(-1)?.index ?? -1, word = preview.lastIndexOf(' ');
    const end = sentence >= 175 ? sentence + 1 : word >= 175 ? word : 350;
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function parseSegments(text) {
  const records = [], lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let active = null;
  for (const line of lines) {
    const timestamp = leadingTimestamp(line);
    if (timestamp) {
      const content = stripCopiedDuration(line.slice(timestamp.length), timestamp.at);
      if (!content) { active = null; continue; }
      active = { at: timestamp.at, end: timestamp.at, text: clean(content) };
      records.push(active);
    } else if (/^\s*chapter\s+\d+\s*:/i.test(line) || !line.trim()) {
      active = null;
    } else if (active) {
      active.text = clean(`${active.text} ${line}`);
    } else {
      active = { at: null, end: null, text: clean(line) };
      records.push(active);
    }
    if (records.length >= MAX_SEGMENTS) break;
  }
  records.forEach((record, index) => {
    const next = records[index + 1];
    if (record.at !== null && next?.at !== null && next?.at !== undefined && next.at > record.at && next.at - record.at <= 70) record.end = next.at;
  });
  const passages = records.flatMap(record => splitPassage(record.text).map(text => ({ ...record, text }))).slice(0, MAX_SEGMENTS);
  passages.forEach((record, index) => {
    record.id = `segment-${index + 1}`;
  });
  return passages;
}

function candidateWindows(segments) {
  const candidates = [];
  for (let start = 0; start < segments.length; start++) {
    const first = segments[start], window = [first];
    let characters = first.text.length;
    for (let index = start + 1; index < segments.length && window.length < 12; index++) {
      const next = segments[index], previous = window.at(-1);
      if ((first.at === null) !== (next.at === null)) break;
      if (first.at !== null && (next.at < previous.at || next.at - previous.at > 20 || next.at - first.at > 45)) break;
      if (first.at === null && window.length >= 2) break;
      if (characters + next.text.length + 1 > MAX_EXCERPT) break;
      characters += next.text.length + 1; window.push(next);
    }
    for (const topic of TOPICS) {
      const matches = window.map((record, index) => ({ index, score: score(record.text, topic) })).filter(value => value.score > 0);
      if (!matches.length) continue;
      let begin = matches[0].index, finish = matches.at(-1).index;
      if (begin && window[begin].at !== null && window[begin].at - window[begin - 1].at <= 8) begin--;
      if (finish + 1 < window.length && window[finish].at !== null && window[finish + 1].at - window[finish].at <= 8) finish++;
      const chosen = window.slice(begin, finish + 1), statement = chosen.map(record => record.text).join(' ').slice(0, MAX_EXCERPT).trim();
      const strength = score(statement, topic);
      if (strength < 5) continue;
      const at = chosen[0].at, last = chosen.at(-1);
      const end = at === null ? null : Math.min(Math.max(at, last.end ?? last.at), at + 70);
      candidates.push({ topic, strength, statement, at, end, recordIds: chosen.map(record => record.id), start });
    }
  }
  return candidates;
}

function overlaps(candidate, selected) {
  return selected.some(other => {
    if (normalized(candidate.statement) === normalized(other.statement)) return true;
    const intersection = candidate.recordIds.filter(id => other.recordIds.includes(id)).length;
    return intersection / Math.min(candidate.recordIds.length, other.recordIds.length) >= 0.5;
  });
}

/** Select research leads with bounded, deterministic matching; no model, network or storage. */
export function scanTranscript(text, { limit = 12 } = {}) {
  const totalCharacters = typeof text === 'string' ? text.length : 0;
  const empty = warning => ({ signals: [], segments: [], totalCharacters, warning });
  if (typeof text !== 'string' || !text.trim()) return empty('Paste a transcript to select candidate passages.');
  if (totalCharacters > MAX_CHARACTERS) return empty('This transcript exceeds the 200,000-character limit. Paste a shorter section. Nothing has been processed or sent anywhere.');
  const maximum = Number.isFinite(Number(limit)) ? Math.min(12, Math.max(0, Math.floor(Number(limit)))) : 12;
  const segments = parseSegments(text), candidates = candidateWindows(segments).sort((a, b) => b.strength - a.strength || a.start - b.start || a.topic.id.localeCompare(b.topic.id));
  const selected = [];
  // One useful passage per available lens first, then fill without repeating the same window.
  for (const topic of TOPICS) {
    if (selected.length >= maximum) break;
    const candidate = candidates.find(value => value.topic.id === topic.id && !overlaps(value, selected));
    if (candidate) selected.push(candidate);
  }
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (!overlaps(candidate, selected)) selected.push(candidate);
  }
  const signals = selected.map((candidate, index) => ({
    id: `local-${candidate.topic.id}-${candidate.at === null ? candidate.start : candidate.at}-${index + 1}`,
    title: candidate.topic.title, topic: candidate.topic.id, at: candidate.at, end: candidate.end,
    statement: candidate.statement, meaning: candidate.topic.meaning,
    limits: 'Automatic passage selection from the pasted text. Statements and interpretations are not independently verified.',
    question: candidate.topic.question, verify: [...candidate.topic.verify], related: [], entities: [],
  }));
  const warning = segments.length >= MAX_SEGMENTS ? 'Passage selection is limited to the first 4,000 transcript segments. Paste a shorter section to inspect the remainder.'
    : signals.length ? null : 'No candidate passages matched these English topic cues. This local selector does not translate text or provide general-purpose analysis.';
  return { signals, segments, totalCharacters, warning };
}
