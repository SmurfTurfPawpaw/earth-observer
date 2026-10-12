import { DEMO_NOW } from './demo-data.js';

// Authored fictional scenarios for visual review. No collected news, external
// source documents, verified relationships, forecasts or real people are used.
const HOUR = 3_600_000;
const ago = (hours) => DEMO_NOW - hours * HOUR;
const question = (label, why, query) => ({ label, why, query });
const finding = (title, body, evidenceIds = []) => ({ title, body, evidenceIds });
const evidence = (id, label, kind, hours, detail) => ({ id, label, kind, at: ago(hours), detail, status: 'Fixture' });
const node = (id, label, type, lon, lat, region) => ({ id, label, type, lon, lat, region, simulated: true, locationMeaning: 'Illustrative regional anchor, not a verified facility or person location.' });
const edge = (from, to, label, kind, evidenceIds = []) => ({ from, to, label, kind, evidenceIds, simulated: true });
const level = (heading, summary, findings, questions = []) => ({ heading, summary, findings, questions });
const fixtureNotice = 'Fictional research scenario. Evidence and connections are authored design fixtures; documented means documented within this scenario.';

export const RESEARCH_LEVELS = freeze([
  { id: 1, label: 'Brief', subtitle: 'Latest developments', description: 'Find the developments and the next useful question.' },
  { id: 2, label: 'Context', subtitle: 'People, places and background', description: 'Understand the participants, setting and relevant history.' },
  { id: 3, label: 'Investigate', subtitle: 'Evidence and open questions', description: 'Compare source material, gaps and competing explanations.' },
  { id: 4, label: 'Systems', subtitle: 'Dependencies and alternatives', description: 'Connect local developments to the systems around them.' },
  { id: 5, label: 'Synthesis', subtitle: 'A considered briefing', description: 'Bring the evidence, alternatives and unknowns into one view.' },
]);

const taiwanQuestions = [
  question('Where does the dependency actually sit?', 'A country label can hide very different equipment, production and design constraints.', 'Which semiconductor dependencies matter for Taiwan?'),
  question('What would change this assessment?', 'Capacity, licences and inventories need separate evidence before drawing a supply conclusion.', 'What evidence could change the Taiwan chip outlook?'),
  question('Who has a practical alternative?', 'An alternative is useful only if its process, qualification and delivery window fit.', 'What alternatives exist in the semiconductor supply chain?'),
  question('Which export-control clause matters?', 'A named equipment class is more useful than a broad trade-policy headline.', 'Trace Taiwan semiconductor export controls to the affected equipment'),
  question('Could power or water become a constraint?', 'The sample has no verified utility data for the fabrication site.', 'Investigate power and water dependencies in Taiwan semiconductor production'),
];

const taiwan = {
  id: 'taiwan-chips',
  query: 'Taiwan and semiconductors',
  aliases: ['taiwan', 'semiconductor', 'semiconductors', 'chips', 'chip supply', 'lithography', 'export controls'],
  title: 'Taiwan and the semiconductor chain',
  kicker: 'INDUSTRY / INTERDEPENDENCE',
  summary: 'Follow a sample production update through equipment, policy, research and demand. See which connections are recorded and which still need evidence.',
  focus: { lon: 120.97, lat: 24.81, zoom: 3 },
  topics: ['Taiwan', 'Semiconductors', 'Trade policy', 'Equipment', 'Supply chains'],
  questions: taiwanQuestions,
  state: 'Fictional fixture', simulated: true, preparedLevel: 5, fixtureNotice,
  levels: {
    1: level('What changed in the sample chain?', 'A production review and a policy clarification bring three dependencies into focus.', [
      finding('A production window is under review', 'The fabrication-site note revises a planned equipment installation window. It does not report a plant shutdown.', ['tw-plant']),
      finding('The policy language is narrower than the headline', 'The policy note concerns a defined equipment class. It does not describe a blanket stop to all chip trade.', ['tw-us-policy', 'tw-cn-policy']),
      finding('Demand remains a separate question', 'The customer-planning note keeps its existing forecast range. That is counterevidence to an immediate demand-collapse claim.', ['tw-demand']),
    ], taiwanQuestions),
    2: level('One chain, several roles', 'Production, equipment, policy and demand belong to different participants and different clocks.', [
      finding('Taiwan: the production step', 'The sample fabrication site handles one manufacturing stage. Design, tools and customers sit elsewhere in the chain.', ['tw-plant']),
      finding('Netherlands and Japan: distinct inputs', 'The equipment schedule comes from Veldhoven; a Tokyo research note discusses process qualification. Neither note establishes a replacement factory.', ['tw-equipment', 'tw-research']),
      finding('United States and China: policy context', 'The Washington and Beijing notes describe separate policy positions. A geographic connection between them is not proof of coordination.', ['tw-us-policy', 'tw-cn-policy']),
    ], [taiwanQuestions[0]]),
    3: level('Read the evidence before the narrative', 'Compare scope and timing, then identify what the sample documents leave unanswered.', [
      finding('Separate the original note from the clarification', 'The equipment note is older than the policy clarification. Their order matters, but chronology alone does not show that one caused the other.', ['tw-equipment', 'tw-us-policy']),
      finding('The chain has a missing inventory picture', 'None of the fixtures provides customer inventories or a confirmed delivery interruption. A shortage claim would need that additional evidence.', ['tw-plant', 'tw-demand']),
      finding('Keep contrary evidence in view', 'The customer note retains its demand range, while the installation window remains under review. These statements can coexist without a single dramatic explanation.', ['tw-demand', 'tw-plant']),
    ], [taiwanQuestions[1], question('Which date does each claim use?', 'An event date, publication date and later correction are different pieces of evidence.', 'Compare the dates behind the Taiwan semiconductor notes')]),
    4: level('Find the constrained link', 'A system view asks where a change could matter and which alternatives would actually work.', [
      finding('Equipment is one dependency, not the whole industry', 'The recorded equipment relationship concerns the sample installation. A wider production effect is a hypothesis until the affected process and capacity are known.', ['tw-equipment', 'tw-plant']),
      finding('Alternatives have qualification costs', 'The research note describes a possible process option, not a ready substitute. Compatibility and qualification time remain open questions.', ['tw-research']),
      finding('A policy change has several possible outcomes', 'A conditional scenario could involve a later installation, a revised tool choice or no practical change. The fixtures do not rank their probability.', ['tw-us-policy', 'tw-cn-policy', 'tw-equipment']),
    ], [taiwanQuestions[2], question('Which dependency can absorb a delay?', 'Buffers and substitute capacity determine whether a local change spreads.', 'How could the semiconductor chain absorb an equipment delay?')]),
    5: level('A briefing with its limits intact', 'The useful conclusion is a focused investigation plan, with assumptions and counterevidence alongside it.', [
      finding('Working assessment', 'The sample supports an installation-window review and limited policy uncertainty. It does not support a confirmed global shortage or a forecast of disruption.', ['tw-plant', 'tw-us-policy', 'tw-cn-policy']),
      finding('What to verify next', 'Obtain the applicable licence terms, equipment delivery status, process qualification and customer inventory picture before extending the analysis.', ['tw-equipment', 'tw-research', 'tw-demand']),
      finding('What could overturn the assessment', 'A confirmed installation on schedule would weaken the delay hypothesis. A verified interruption tied to the affected process would strengthen it.', ['tw-plant', 'tw-equipment']),
      finding('Conditional scenario, not a prediction', 'If the equipment window slips and there is no qualified substitute, the affected process could face a later ramp. Each condition needs independent evidence.', ['tw-equipment', 'tw-research']),
    ], [taiwanQuestions[1], taiwanQuestions[2]]),
  },
  nodes: [
    node('tw-plant-node', 'Taiwan fabrication site', 'facility', 120.97, 24.81, 'Taiwan'),
    node('tw-us-node', 'Washington policy desk', 'policy', -77.04, 38.91, 'United States'),
    node('tw-cn-node', 'Beijing export-control desk', 'policy', 116.41, 39.90, 'China'),
    node('tw-tool-node', 'Veldhoven equipment workshop', 'equipment', 5.41, 51.42, 'Netherlands'),
    node('tw-research-node', 'Tokyo process research', 'research', 139.65, 35.68, 'Japan'),
    node('tw-demand-node', 'California customer planning', 'market', -121.89, 37.34, 'United States'),
  ],
  edges: [
    edge('tw-tool-node', 'tw-plant-node', 'Equipment installation plan', 'documented', ['tw-equipment', 'tw-plant']),
    edge('tw-us-node', 'tw-tool-node', 'Policy scope under review', 'documented', ['tw-us-policy']),
    edge('tw-cn-node', 'tw-plant-node', 'Trade-policy context', 'documented', ['tw-cn-policy']),
    edge('tw-research-node', 'tw-plant-node', 'Process qualification study', 'documented', ['tw-research']),
    edge('tw-demand-node', 'tw-plant-node', 'Customer planning reference', 'documented', ['tw-demand']),
    edge('tw-tool-node', 'tw-demand-node', 'Possible delivery effect', 'hypothesis', ['tw-equipment', 'tw-demand']),
  ],
  evidence: [
    evidence('tw-plant', 'Fabrication-site planning note', 'Operations note', 2, 'The installation window is under review; the note gives no confirmed production interruption.'),
    evidence('tw-us-policy', 'Equipment policy clarification', 'Policy note', 5, 'The sample policy applies to a defined equipment class and leaves individual licence decisions unresolved.'),
    evidence('tw-cn-policy', 'Trade-policy response note', 'Policy note', 9, 'The sample response describes a policy position, without naming an implemented production restriction.'),
    evidence('tw-equipment', 'Equipment delivery schedule', 'Supplier note', 18, 'A planned installation depends on delivery and site acceptance. The fixture does not confirm either milestone.'),
    evidence('tw-research', 'Process qualification memo', 'Research note', 30, 'An alternative process is being studied; qualification time and compatibility have not been established.'),
    evidence('tw-demand', 'Customer planning update', 'Demand note', 12, 'The customer retains a demand range and supplies no inventory figures or confirmed shipment cancellations.'),
  ],
  developments: [
    { at: ago(30), title: 'An alternative process enters the discussion', body: 'The research memo adds a possible option, with qualification still unresolved.' },
    { at: ago(18), title: 'Equipment dates provide a baseline', body: 'The delivery schedule establishes the planned window against which later changes can be compared.' },
    { at: ago(5), title: 'Policy scope is clarified', body: 'A narrower equipment category replaces a broader reading of the sample policy note.' },
    { at: ago(2), title: 'The installation window is reviewed', body: 'The site note adds a planning change without reporting a shutdown.' },
  ],
  briefing: [
    finding('The short read', 'Watch the specific installation and qualification steps before extending this sample story to the global chip market.', ['tw-plant', 'tw-equipment', 'tw-research']),
    finding('The open question', 'Is the revised window an administrative change or a meaningful constraint on the affected process?', ['tw-plant']),
    finding('The counterweight', 'The demand note has not changed its forecast range; inventories and confirmed deliveries are still missing.', ['tw-demand']),
  ],
  communityNotes: [
    { id: 'tw-note-scope', label: 'Sample note', stance: 'support', body: 'Keeping the equipment category narrow makes the investigation more useful than a general shortage narrative.', evidenceIds: ['tw-us-policy', 'tw-equipment'] },
    { id: 'tw-note-inventory', label: 'Sample note', stance: 'challenge', body: 'The missing inventory and delivery picture prevents the sample from establishing a downstream shortage.', evidenceIds: ['tw-demand', 'tw-plant'] },
    { id: 'tw-note-utilities', label: 'Sample note', stance: 'context', body: 'Power and water are questions to investigate here. This scenario supplies no utility observations for the site.', evidenceIds: [] },
  ],
};

const spaceQuestions = [
  question('What is the smallest useful mission?', 'Start with the decision the project must support before choosing hardware.', 'Define the first useful Athena space mission'),
  question('Which dependency could stop the project?', 'Launch, licensing, communications and hardware have different lead times.', 'Map the critical dependencies of a space project'),
  question('Could the same goal be met from the ground?', 'An alternative may achieve the useful outcome with fewer commitments.', 'Compare a satellite mission with ground-based alternatives'),
  question('Which spectrum and licence checks come first?', 'Regulation can affect the design before hardware is purchased.', 'Identify spectrum and licence questions for the Athena space project'),
  question('Where would the ground station fit?', 'Contact windows, operating permissions and downlink needs belong in the plan.', 'Explore ground stations and launch windows for the Athena space project'),
];

const space = {
  id: 'athena-space',
  query: 'I am building a space project',
  aliases: ['athena', 'space', 'satellite', 'satellites', 'orbital', 'launch', 'building a space project', 'i am building a space project'],
  title: 'Athena: shape a space project',
  kicker: 'PROJECT / FROM GOAL TO PLAN',
  summary: 'Turn an ambition into a useful mission. Compare a small orbital concept with ground-based alternatives and make the dependencies visible.',
  focus: { lon: 7.5, lat: 46.5, zoom: 2.1 },
  topics: ['Space project', 'Mission design', 'Launch', 'Communications', 'Alternatives'],
  questions: spaceQuestions,
  state: 'Fictional fixture', simulated: true, preparedLevel: 5, fixtureNotice,
  levels: {
    1: level('Start with the useful outcome', 'Athena is an imaginary small-space-project concept, not a real mission or launch announcement.', [
      finding('The goal needs a sharper definition', 'The concept brief asks for repeat observations of a coastal area, but does not specify the decision those observations should support.', ['sp-goal']),
      finding('The first choice is a scope choice', 'The mission worksheet compares a small payload, hosted hardware and existing public observations. No option has been selected.', ['sp-options']),
    ], spaceQuestions),
    2: level('A mission is more than a payload', 'The project sits between hardware, launch services, communications, licences and a user need.', [
      finding('Hardware and access have different owners', 'The sample payload and launch notes describe separate interfaces. A functioning instrument does not establish a launch slot.', ['sp-hardware', 'sp-launch']),
      finding('Communications belong in the initial scope', 'The ground-link worksheet makes contact windows and downlink capacity explicit, without claiming continuous coverage.', ['sp-ground']),
      finding('The project name is a working label', 'Athena identifies this design scenario only. The concept has no relationship to any existing named space mission.', ['sp-goal']),
    ], [spaceQuestions[1]]),
    3: level('Test the expensive assumptions early', 'Use the sample documents to distinguish a stated need from an untested design assumption.', [
      finding('Observation frequency is not yet justified', 'The user brief asks for repeated views, but the acceptable delay and resolution remain unspecified.', ['sp-goal']),
      finding('Launch readiness is missing', 'The launch worksheet contains a candidate window, not a booking. Qualification and integration requirements are unanswered.', ['sp-launch', 'sp-hardware']),
      finding('An existing-data pilot is counterevidence', 'The options note shows that a ground workflow could test the user decision before new orbital hardware is required.', ['sp-options']),
    ], [spaceQuestions[0], spaceQuestions[2]]),
    4: level('Build the dependency path', 'Connect the minimum mission to the resources and approvals it would need.', [
      finding('Work backwards from the decision', 'Specify useful observations, then compare sensor, communications and processing choices. Do not begin by assuming a satellite is necessary.', ['sp-goal', 'sp-options']),
      finding('Treat the orbital path as conditional', 'An orbital concept would depend on hardware qualification, an available launch arrangement and a workable ground link.', ['sp-hardware', 'sp-launch', 'sp-ground']),
      finding('Keep a smaller alternative active', 'An existing-data prototype can test whether the observation product is useful. Its limits differ from the orbital concept and must be compared.', ['sp-options']),
    ], [spaceQuestions[1], spaceQuestions[2]]),
    5: level('A plan with explicit decision gates', 'The next step is a modest validation exercise, not a commitment to a spacecraft.', [
      finding('Proposed first step', 'Write one user decision and evaluate it using available observations. Measure the required delay and resolution before choosing a mission route.', ['sp-goal', 'sp-options']),
      finding('Proceed only if the need survives', 'If existing observations cannot meet the defined need, compare hosted and independent payload options against the same requirements.', ['sp-options', 'sp-hardware']),
      finding('What remains unknown', 'The scenario has no verified budget, launch availability, licence path or qualified hardware. It cannot support a launch-date forecast.', ['sp-launch', 'sp-hardware', 'sp-ground']),
    ], [spaceQuestions[0], spaceQuestions[1]]),
  },
  nodes: [
    node('sp-concept-node', 'Athena concept team', 'project', 4.35, 50.85, 'Belgium'),
    node('sp-payload-node', 'Payload design workshop', 'research', 11.58, 48.14, 'Germany'),
    node('sp-launch-node', 'Candidate launch region', 'logistics', -52.65, 5.24, 'French Guiana'),
    node('sp-ground-node', 'Ground-link planning site', 'communications', 20.22, 67.86, 'Sweden'),
    node('sp-observation-node', 'Coastal observation region', 'region', -9.15, 38.72, 'Portugal'),
  ],
  edges: [
    edge('sp-concept-node', 'sp-observation-node', 'Proposed observation goal', 'documented', ['sp-goal']),
    edge('sp-concept-node', 'sp-payload-node', 'Concept requirements', 'documented', ['sp-hardware']),
    edge('sp-payload-node', 'sp-launch-node', 'Possible integration path', 'hypothesis', ['sp-hardware', 'sp-launch']),
    edge('sp-ground-node', 'sp-observation-node', 'Possible data-delivery path', 'hypothesis', ['sp-ground']),
  ],
  evidence: [
    evidence('sp-goal', 'Athena concept brief', 'Project brief', 3, 'An imaginary project seeks repeat coastal observations; the user decision, delay and resolution are not yet defined.'),
    evidence('sp-options', 'Mission options worksheet', 'Comparison', 8, 'Existing observations, hosted hardware and an independent payload are compared without selecting a winner.'),
    evidence('sp-hardware', 'Payload interface sketch', 'Technical note', 15, 'The sketch lists interfaces and an untested qualification path, not flight-ready hardware.'),
    evidence('sp-launch', 'Candidate launch worksheet', 'Planning note', 24, 'The candidate window is exploratory and is not a confirmed booking or launch offer.'),
    evidence('sp-ground', 'Ground-link worksheet', 'Systems note', 18, 'Contact windows, downlink capacity and operating responsibilities require validation.'),
  ],
  developments: [
    { at: ago(24), title: 'A candidate route is sketched', body: 'The launch worksheet provides questions to investigate rather than a promised slot.' },
    { at: ago(8), title: 'Alternatives enter the comparison', body: 'An existing-observation workflow is added alongside two hardware paths.' },
    { at: ago(3), title: 'The user goal takes priority', body: 'The concept brief makes the required decision the first question to answer.' },
  ],
  briefing: [
    finding('The short read', 'Begin with a useful observation product; earn the case for hardware rather than assuming it.', ['sp-goal', 'sp-options']),
    finding('The first gate', 'Can an existing-data pilot support the intended decision with acceptable delay and resolution?', ['sp-options']),
    finding('The commitment gate', 'Do not choose an orbital route until qualification, access, communications and operating cost can be evaluated together.', ['sp-hardware', 'sp-launch', 'sp-ground']),
  ],
  communityNotes: [
    { id: 'sp-note-pilot', label: 'Sample note', stance: 'support', body: 'An existing-observation pilot could clarify the useful outcome before the project commits to new hardware.', evidenceIds: ['sp-goal', 'sp-options'] },
    { id: 'sp-note-access', label: 'Sample note', stance: 'challenge', body: 'The launch worksheet is not a booking. The concept needs a credible access and qualification path.', evidenceIds: ['sp-launch', 'sp-hardware'] },
    { id: 'sp-note-spectrum', label: 'Sample note', stance: 'context', body: 'Spectrum, licensing and ground-station permissions are open questions, with no approved regulatory route in the fixtures.', evidenceIds: ['sp-ground'] },
  ],
};

const energyQuestions = [
  question('Which volume is actually exposed?', 'Country totals and a specific terminal window describe different things.', 'Which European energy volumes are exposed to the terminal change?'),
  question('What can replace the affected route?', 'A substitute requires capacity, timing and a compatible connection.', 'Compare alternatives for European energy logistics'),
  question('What evidence would change the outlook?', 'Reported stocks and operating capacity matter more than a dramatic headline.', 'What could change the European energy assessment?'),
];

const energy = {
  id: 'europe-energy',
  query: 'Europe and energy security',
  aliases: ['energy', 'europe', 'european energy', 'gas', 'electricity', 'power', 'energy security', 'terminal', 'supply'],
  title: 'Europe: energy routes and resilience',
  kicker: 'RESOURCES / RESILIENCE',
  summary: 'Trace a sample terminal update through storage, industry and alternative routes. Keep the reported change separate from possible wider effects.',
  focus: { lon: 5.8, lat: 49.8, zoom: 2.6 },
  topics: ['Europe', 'Energy', 'Storage', 'Infrastructure', 'Industry'],
  questions: energyQuestions,
  state: 'Fictional fixture', simulated: true, preparedLevel: 5, fixtureNotice,
  levels: {
    1: level('A terminal update, not a continental verdict', 'The sample starts with a revised handling window and three unanswered operational questions.', [
      finding('One handling window changes', 'The terminal notice revises a scheduled operating period. It does not report a permanent loss of supply.', ['en-terminal']),
      finding('Storage gives a partial counterweight', 'A separate stock note reports available stored volume but leaves withdrawal capacity and regional access unclear.', ['en-storage']),
      finding('Industry exposure is unresolved', 'The industrial note names a planning concern without quantifying a production interruption.', ['en-industry']),
    ], energyQuestions),
    2: level('Routes, stocks and use are different layers', 'A resource can be present in a system without being deliverable to every user at the required time.', [
      finding('A terminal is a handling step', 'The sample port note describes timing at one location. It cannot establish the supply position of every connected country.', ['en-terminal']),
      finding('Stored volume is not instantaneous delivery', 'Withdrawal, connections and demand determine how useful a stock buffer is. The stock figure alone does not answer those questions.', ['en-storage', 'en-industry']),
      finding('An alternative route has its own constraints', 'The Iberian route worksheet identifies another entry path, while spare capacity and connection availability remain unverified.', ['en-alternative']),
    ], [energyQuestions[0], energyQuestions[1]]),
    3: level('Compare like with like', 'Read the source periods, units and operating scope before combining the sample notes.', [
      finding('The observation windows do not align', 'The handling note covers a short period; the storage note is an earlier snapshot. Combining them as one current supply measure would be misleading.', ['en-terminal', 'en-storage']),
      finding('The exposed quantity is missing', 'No fixture states how much scheduled volume is affected. The scenario cannot support a percentage supply-loss estimate.', ['en-terminal']),
      finding('Counterevidence belongs in the assessment', 'Available stocks and an alternative entry path challenge a simple shortage narrative, even though their usable capacity still needs checking.', ['en-storage', 'en-alternative']),
    ], [energyQuestions[2]]),
    4: level('Trace the constraint through the system', 'Connect the specific handling change to buffers and routes without turning a connection into a causal forecast.', [
      finding('A conditional bottleneck', 'If the revised window affects deliveries and buffers cannot bridge it, some connected users could face tighter scheduling. Neither condition is established.', ['en-terminal', 'en-storage', 'en-industry']),
      finding('Several alternatives remain open', 'A later handling slot, usable stocks, an alternative route or lower demand could absorb part of the change. Their costs and capacity are unknown.', ['en-alternative', 'en-storage', 'en-industry']),
      finding('Demand can alter the same supply picture', 'The industry worksheet leaves the consumption outlook open. A supply-only model would omit that part of the system.', ['en-industry']),
    ], [energyQuestions[1], energyQuestions[2]]),
    5: level('A proportionate resilience briefing', 'The sample supports targeted operational checks, not a general claim of European energy failure.', [
      finding('Working assessment', 'One terminal window is revised. The wider effect remains unresolved because exposed volume, usable buffers and alternate capacity are missing.', ['en-terminal', 'en-storage', 'en-alternative']),
      finding('The next useful evidence', 'Request the affected volume and period, withdrawal and connection capacity, then the relevant demand outlook. Keep each reference date visible.', ['en-terminal', 'en-storage', 'en-industry']),
      finding('Scenario boundary', 'A short delay absorbed by stocks and a delay that reaches industrial users are different conditional cases. The fixtures do not assign probabilities or price effects.', ['en-storage', 'en-industry']),
    ], energyQuestions),
  },
  nodes: [
    node('en-terminal-node', 'North Sea terminal window', 'infrastructure', 4.48, 51.92, 'Netherlands'),
    node('en-storage-node', 'Central storage region', 'resource', 9.2, 51.2, 'Germany'),
    node('en-industry-node', 'Belgian industrial planning', 'industry', 4.4, 51.2, 'Belgium'),
    node('en-route-node', 'Iberian entry-route option', 'logistics', -8.87, 37.95, 'Portugal'),
    node('en-demand-node', 'Southern demand region', 'market', 9.19, 45.46, 'Italy'),
  ],
  edges: [
    edge('en-terminal-node', 'en-industry-node', 'Planning reference', 'documented', ['en-terminal', 'en-industry']),
    edge('en-storage-node', 'en-industry-node', 'Possible buffer', 'hypothesis', ['en-storage']),
    edge('en-route-node', 'en-industry-node', 'Alternative route to assess', 'hypothesis', ['en-alternative']),
    edge('en-demand-node', 'en-storage-node', 'Demand-planning context', 'documented', ['en-industry']),
  ],
  evidence: [
    evidence('en-terminal', 'Terminal operating-window note', 'Operations note', 2, 'A scheduled handling period is revised; affected volume and actual delivery disruption are not reported.'),
    evidence('en-storage', 'Regional stock snapshot', 'Observation note', 20, 'Stored volume is reported for an earlier period. Withdrawal and regional delivery capacity are unspecified.'),
    evidence('en-industry', 'Industrial planning worksheet', 'Demand note', 6, 'The worksheet describes a scheduling concern and an open demand range, without a confirmed production loss.'),
    evidence('en-alternative', 'Alternative entry-route worksheet', 'Scenario input', 10, 'Another route is listed for investigation. Spare capacity, compatibility and delivery timing require evidence.'),
  ],
  developments: [
    { at: ago(20), title: 'Stocks provide a dated baseline', body: 'The stock snapshot adds context but does not establish deliverable capacity.' },
    { at: ago(10), title: 'An alternative route is considered', body: 'The worksheet adds a possibility with unresolved capacity and connection questions.' },
    { at: ago(2), title: 'The handling period is revised', body: 'The terminal notice changes the schedule without quantifying a wider supply effect.' },
  ],
  briefing: [
    finding('The short read', 'Assess the exposed volume and usable buffers before describing a wider supply problem.', ['en-terminal', 'en-storage']),
    finding('The alternative', 'Another entry route is a lead to investigate, not established replacement capacity.', ['en-alternative']),
    finding('The limit', 'The sample cannot estimate shortage probability, industrial losses or energy prices.', ['en-terminal', 'en-industry']),
  ],
  communityNotes: [
    { id: 'en-note-volume', label: 'Sample note', stance: 'support', body: 'The affected volume is the most useful next check. A schedule change alone does not quantify lost supply.', evidenceIds: ['en-terminal'] },
    { id: 'en-note-buffer', label: 'Sample note', stance: 'challenge', body: 'Stored volume may not be usable where and when it is needed. Withdrawal and connections need their own evidence.', evidenceIds: ['en-storage'] },
    { id: 'en-note-demand', label: 'Sample note', stance: 'context', body: 'The consumption outlook can change the same supply picture. Keep demand assumptions visible beside route scenarios.', evidenceIds: ['en-industry'] },
  ],
};

export const demoInvestigations = freeze([taiwan, space, energy]);

export const researchWorldSignals = freeze([
  { id: 'fixture:riverland-flood', category: 'natural', kind: 'flood', symbol: 'flood', headline: 'Riverland district issues a flood advisory', summary: 'Rising water prompts an advisory in the sample district. The affected area is still being assessed.', place: 'Riverland district · scenario', region: 'Bangladesh', lon: 91.1, lat: 23.9, ageMinutes: 18, severity: 'high', investigationId: null },
  { id: 'fixture:west-channel', category: 'mobility', kind: 'transport', symbol: 'transport', headline: 'Western shipping corridor reports a delay', summary: 'A sample access delay changes vessel scheduling in the corridor. Its duration and wider effect remain unclear.', place: 'Western channel · scenario', region: 'Indonesia', lon: 105.8, lat: -5.95, ageMinutes: 31, severity: 'medium', investigationId: null },
  { id: 'fixture:western-grid', category: 'economy', kind: 'energy', symbol: 'energy', headline: 'Western grid district reports a power outage', summary: 'A sample power interruption affects the district. Operators are reviewing restoration arrangements without a confirmed completion time.', place: 'Western grid district · scenario', region: 'United States', lon: -119.0, lat: 34.8, ageMinutes: 42, severity: 'medium', investigationId: null },
  { id: 'fixture:coastal-evacuation', category: 'natural', kind: 'storm', symbol: 'storm', headline: 'Coastal district begins a precautionary evacuation', summary: 'The sample district opens a precautionary evacuation route. The notice provides context, without an estimated casualty count.', place: 'Southern coastal district · scenario', region: 'Philippines', lon: 123.2, lat: 13.5, ageMinutes: 54, severity: 'high', investigationId: null },
  { id: 'fixture:water-advisory', category: 'natural', kind: 'drought', symbol: 'drought', headline: 'Southern farming region reviews water reserves', summary: 'A sample monitoring note reviews local water reserves. Irrigation arrangements are being considered while further observations are gathered.', place: 'Southern farming region · scenario', region: 'Spain', lon: -5.0, lat: 38.5, ageMinutes: 78, severity: 'low', investigationId: null },
  { id: 'fixture:terminal-window', category: 'economy', kind: 'energy', symbol: 'energy', headline: 'North Sea terminal revises a handling window', summary: 'The sample terminal changes a scheduled operating period. Exposed volume and the effect on connected users remain unresolved.', place: 'North Sea terminal region · scenario', region: 'Netherlands', lon: 4.48, lat: 51.92, ageMinutes: 120, severity: 'low', investigationId: 'europe-energy' },
].map((signal) => ({ ...signal, country: signal.region, occurredAt: DEMO_NOW - signal.ageMinutes * 60_000, at: DEMO_NOW - signal.ageMinutes * 60_000,
  simulated: true, status: 'Fixture', locationMeaning: 'Fictional event at an illustrative regional anchor; not an observed incident.' })));

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
