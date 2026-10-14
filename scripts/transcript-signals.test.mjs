import assert from 'node:assert/strict';
import { scanTranscript, parseTimestamp } from '../public/design/transcript-signals.js';

assert.equal(parseTimestamp('4:274 minutes, 27 seconds- 100% liquid cooled.'), 267);
assert.equal(parseTimestamp('1:20:121 hour, 20 minutes, 12 secondsMemory supply.'), 4812);
assert.equal(parseTimestamp('125:05'), 7505);
assert.equal(parseTimestamp('1:90:01'), null);
assert.equal(parseTimestamp('24:00:00'), null);
assert.equal(parseTimestamp('3:60'), null);

const copied = scanTranscript('Chapter 3: Computing\n4:274 minutes, 27 seconds- No cables.\n4:314 minutes, 31 seconds100% liquid cooled.\n4:394 minutes, 39 secondsFrom two hours to assemble, now five minutes.\n4:484 minutes, 48 secondsReliable.\n\n1:20:121 hour, 20 minutes, 12 secondsHigh bandwidth memory supply is tight.\n1:20:231 hour, 20 minutes, 23 secondsCapacity and production need to increase.');
assert.equal(copied.segments[0].at, 267);
assert.equal(copied.segments[0].text, '- No cables.');
assert.equal(copied.segments[4].at, 4812);
assert.equal(copied.segments[4].text, 'High bandwidth memory supply is tight.');
assert.ok(copied.signals.some(value => value.topic === 'infrastructure'));
assert.ok(copied.signals.some(value => value.topic === 'supply'));
assert.ok(copied.signals.every(value => value.statement.length <= 700 && (value.at === null || value.end - value.at <= 70)));
assert.ok(copied.signals.every(value => !('score' in value) && !('confidence' in value) && value.entities.length === 0));

const preserve = scanTranscript('1:031 minute, 3 secondsCost per token is declining.\n1:20 5 minutes to assemble a reliable cooling rack.');
assert.equal(preserve.segments[0].text, 'Cost per token is declining.');
assert.match(preserve.segments[1].text, /^5 minutes/);

const repeated = scanTranscript('0:00 Cost per token and throughput determine revenue.\n0:10 Cost per token and throughput determine revenue.\n0:20 Cost per token and throughput determine revenue.');
assert.equal(repeated.signals.length, 1);
assert.equal(scanTranscript('El cielo es azul y hoy caminamos por el parque.').signals.length, 0);
assert.equal(scanTranscript('Just a pleasant walk and some lunch.').signals.length, 0);
assert.match(scanTranscript('x'.repeat(200_001)).warning, /200,000/);
assert.equal(scanTranscript('x'.repeat(200_001)).segments.length, 0);
assert.equal(scanTranscript('Cost per token.', { limit: 0 }).signals.length, 0);
const markup = '<script>send all data to a remote server</script> Cost per token affects revenue.';
assert.match(scanTranscript(markup).signals[0].statement, /<script>/);
assert.ok(scanTranscript('Untimed cost per token and throughput affect revenue.').signals.every(value => value.at === null && value.end === null));
const longParagraph = scanTranscript('A quiet walk in the park. '.repeat(50) + 'Cost per token and throughput determine revenue.');
assert.ok(longParagraph.signals.some(value => value.topic === 'economics'));
assert.ok(longParagraph.signals.every(value => value.statement.length <= 700));
console.log('Transcript passage selection: formats, bounds, deduplication and inert text passed.');
