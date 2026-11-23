import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcript, dayStart, entriesFromState, localTime, type Entry } from '../src/transcript.js';
import { ago, historyTools } from '../src/tools/history.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gwen-transcript-'));
const line = (t: string, conversation: string, speaker: string, text: string): Entry => ({
  t, adapter: conversation.split(':')[0]!, conversation, speaker, text,
});

function seeded(): { transcript: Transcript; data: string } {
  const data = dir();
  const transcript = new Transcript(data);
  for (const e of [
    line('2026-10-30T15:00:00.000Z', 'buzz:a', 'Rick', 'What was the name of that Longhorn replica setting?'),
    line('2026-10-30T15:00:09.000Z', 'buzz:a', 'Gwen', 'numberOfReplicas, set per volume.'),
    line('2026-11-02T03:00:00.000Z', 'telegram:1', 'Rick', 'Remind me about the dentist'),
    line('2026-11-02T03:00:05.000Z', 'telegram:1', 'Gwen', 'Dentist is Thursday at 2.'),
    line('2026-11-02T03:01:00.000Z', 'telegram:1', 'Rick', 'ok thanks'),
    line('2026-11-02T03:02:00.000Z', 'buzz:a', 'Rick', 'unrelated buzz line'),
    line('2026-11-20T18:00:00.000Z', 'telegram:1', 'Rick', 'Move the DENTIST appointment to Friday'),
  ]) transcript.append(e);
  return { transcript, data };
}

test('lines are stored one file per UTC month', () => {
  const { data } = seeded();
  assert.deepEqual(readdirSync(join(data, 'transcript')).sort(), ['2026-10.jsonl', '2026-11.jsonl']);
});

test('search: every word, any case, newest first, with context from the same conversation only', () => {
  const { transcript } = seeded();
  const { total, passages } = transcript.search('dentist', {}, 10, 1);
  assert.equal(total, 3);
  assert.equal(passages[0]!.find((l) => l.match)!.text, 'Move the DENTIST appointment to Friday');
  assert.deepEqual(passages[0]!.map((l) => [l.text, l.match]), [['ok thanks', false], ['Move the DENTIST appointment to Friday', true]]);
  // The two older matches sit next to each other, so they share one passage,
  // and "ok thanks" is not repeated: no line is shown twice.
  assert.equal(passages.length, 2);
  assert.deepEqual(passages[1]!.map((l) => [l.speaker, l.match]), [['Rick', true], ['Gwen', true]]);
  assert.ok(passages.flat().every((l) => l.conversation === 'telegram:1'));

  assert.equal(transcript.search('replica longhorn', {}, 10, 0).total, 1);
  assert.equal(transcript.search('dentist longhorn', {}, 10, 0).total, 0);
});

test('search: date range, platform and limit narrow the result', () => {
  const { transcript } = seeded();
  const november2 = { from: new Date('2026-11-02T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') };
  assert.equal(transcript.search('dentist', november2, 10, 0).total, 2);
  assert.equal(transcript.search('dentist', { adapter: 'buzz' }, 10, 0).total, 0);
  const limited = transcript.search('dentist', {}, 1, 0);
  assert.equal(limited.total, 3);
  assert.equal(limited.passages.length, 1);
});

test('browse returns a period oldest first', () => {
  const { transcript } = seeded();
  const { total, lines } = transcript.browse({ from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') }, 2);
  assert.equal(total, 4);
  assert.deepEqual(lines.map((l) => l.text), ['Remind me about the dentist', 'Dentist is Thursday at 2.']);
});

test('a line cut short by a crash is skipped, not fatal', () => {
  const { transcript, data } = seeded();
  appendFileSync(join(data, 'transcript', '2026-11.jsonl'), '{"t":"2026-11-21T00:00:00.000Z","adapter":"tele');
  assert.equal(transcript.search('dentist', {}, 10, 0).total, 3);
});

const framed = (now: string, text: string) =>
  `<context machine-generated="true">\nnow: ${now} (UTC)\nrouting: x\nmemory:\n- [about-user] Rick: said something\n</context>\n\nRick: ${text}`;
const said = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('backfill: messages keep their own time, only the sent reply is kept, machine input is skipped', () => {
  const state = {
    id: 'telegram:1',
    createdAt: Date.parse('2026-11-22T00:00:00Z'),
    messages: [
      { role: 'user', content: framed('2026-11-22T01:00:00.000Z', 'first\nwith: a colon') },
      said('let me look'),
      { type: 'function_call' },
      { type: 'function_call_output' },
      said('the answer'),
      { role: 'user', content: '[background research result — machine-generated, not a message from Rick]\njob: r-1' },
      said('Your report is in.'),
      { role: 'user', content: framed('2026-11-22T02:00:00.000Z', 'second') },
    ],
  };
  assert.deepEqual(
    entriesFromState(state).map((e) => [e.t, e.speaker, e.text]),
    [
      ['2026-11-22T01:00:00.000Z', 'Rick', 'first\nwith: a colon'],
      ['2026-11-22T01:00:00.001Z', 'Gwen', 'the answer'],
      ['2026-11-22T01:00:00.002Z', 'Gwen', 'Your report is in.'],
      ['2026-11-22T02:00:00.000Z', 'Rick', 'second'],
    ],
  );
  assert.equal(entriesFromState(state)[0]!.adapter, 'telegram');
  assert.deepEqual(entriesFromState({ nothing: true }), []);
});

test('backfill runs once: never into a transcript that already has lines', () => {
  const state = { id: 'buzz:a', messages: [{ role: 'user', content: framed('2026-11-22T01:00:00.000Z', 'hello') }] };
  const fresh = new Transcript(dir());
  assert.equal(fresh.backfill([state]), 1);
  assert.equal(fresh.backfill([state]), 0);
  assert.equal(fresh.search('hello', {}, 10, 0).total, 1);
});

test('days begin at local midnight, across a clock change', () => {
  assert.equal(dayStart('2026-11-22', 'America/Chicago').toISOString(), '2026-11-22T06:00:00.000Z');
  assert.equal(dayStart('2026-07-04', 'America/Chicago').toISOString(), '2026-07-04T05:00:00.000Z');
  // Clocks go back on 2026-11-01: that day starts on CDT and the next on CST.
  assert.equal(dayStart('2026-11-01', 'America/Chicago').toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(dayStart('2026-11-01', 'America/Chicago', 1).toISOString(), '2026-11-02T06:00:00.000Z');
  assert.equal(dayStart('2026-11-22', 'UTC').toISOString(), '2026-11-22T00:00:00.000Z');
  assert.equal(localTime('2026-11-23T02:51:07.259Z', 'America/Chicago'), '2026-11-22 20:51 CST');
});

type Run = (input: Record<string, unknown>) => Promise<Record<string, any>>;
function searchTool(transcript: Transcript, asOf: string): Run {
  const [t] = historyTools(transcript, { ownerName: 'Rick', timeZone: 'America/Chicago', platforms: ['buzz', 'telegram'], asOf: new Date(asOf) });
  const fn = (t as unknown as { function: { execute: (i: unknown, c?: unknown) => Promise<Record<string, any>>; inputSchema: { parse(i: unknown): unknown } } }).function;
  return (input) => fn.execute(fn.inputSchema.parse(input));
}

test('search_history: local dates in and out, and nothing from the current turn onward', async () => {
  const { transcript } = seeded();
  const run = searchTool(transcript, '2026-11-20T18:00:00.000Z');
  // The 18:00Z line is the turn asking the question, so it is not found.
  const found = await run({ query: 'dentist' });
  assert.equal(found.matches, 2);
  assert.equal(found.passages[0][0].when, '2026-11-01 21:00 CST');
  assert.equal(found.passages[0][0].platform, 'telegram');
  assert.equal(found.passages[0][0].ago, '19 days ago');
  assert.deepEqual([20_000, 19 * 60_000, 26 * 3_600_000 + 5 * 60_000].map(ago), ['under a minute ago', '19 min ago', '26 h 5 min ago']);

  // 03:00Z on the 2nd is the evening of the 1st in Chicago.
  assert.equal((await run({ query: 'dentist', from: '2026-11-01', to: '2026-11-01' })).matches, 2);
  assert.equal((await run({ query: 'dentist', from: '2026-11-02', to: '2026-11-02' })).matches, 0);
  assert.equal((await run({ from: '2026-11-01', to: '2026-11-01', platform: 'buzz' })).total, 1);
  assert.match((await run({})).error, /query, a date range/);
  assert.match((await run({ query: 'x', platform: 'slack' })).error, /Unknown platform/);
});
