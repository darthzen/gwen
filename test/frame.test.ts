import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentLines, formatMemories, formatRouting, frameJobResult, frameMessage } from '../src/frame.js';
import type { Routing } from '../src/jev.js';
import type { Job } from '../src/store.js';

const routed = (over: Partial<Routing>): Routing => ({ route: null, picked: null, confidence: 0, ms: 1, ...over });

test('memories are labelled by scope and dated when a date is known', () => {
  const text = formatMemories([
    { text: 'Images default to BCI.', scope: 'user', when: '2026-08-25' },
    { text: 'Keep replies short.', scope: 'self' },
  ]);
  assert.equal(text, '- [about-user 2026-08-25] Images default to BCI.\n- [own-note] Keep replies short.');
});

test('an empty recall is stated, so the model does not read silence as a fault', () => {
  assert.match(formatMemories([]), /returned nothing/);
});

test('routing line: confident pick, unavailable, and unclear', () => {
  assert.match(formatRouting(routed({ route: 'research', picked: 'research', confidence: 0.9 })), /start_research/);
  assert.match(formatRouting(routed({ error: 'HTTP 500' })), /was unavailable/);
  assert.match(formatRouting(routed({ picked: 'clarify', confidence: 0.4 })), /no clear routing/);
});

test('a framed message puts the context block first and the speaker line last', () => {
  const framed = frameMessage({
    senderName: 'Rick',
    text: 'hello',
    memories: [],
    routing: routed({ route: 'direct', picked: 'direct', confidence: 1 }),
    now: new Date('2026-11-22T12:00:00Z'),
  });
  const lines = framed.split('\n');
  assert.equal(lines[0], '<context machine-generated="true">');
  assert.equal(lines[1], 'now: 2026-11-22T12:00:00.000Z (UTC)');
  assert.equal(lines.at(-1), 'Rick: hello');
});

test('a job result carries the report when done and the error when failed', () => {
  const job: Job = {
    id: 'r-1', adapter: 'cli', conversationId: 'cli:local', replyRef: null,
    question: 'q?', context: '', status: 'done', createdAt: '', delivered: false, report: 'the answer',
  };
  assert.match(frameJobResult(job, 'Rick'), /status: finished\nreport:\nthe answer/);
  assert.match(frameJobResult({ ...job, status: 'failed', error: 'boom' }, 'Rick'), /status: failed\nerror: boom/);
});

test('recent lines keep only the newest few, per conversation', () => {
  const recent = new RecentLines(2, 10);
  recent.add('a', 'Rick', 'one');
  recent.add('a', 'Gwen', 'two');
  recent.add('a', 'Rick', 'a long third line');
  recent.add('b', 'Rick', 'other');
  assert.equal(recent.text('a'), 'Gwen: two\nRick: a lo');
  assert.equal(recent.text('b'), 'Rick: othe');
  assert.equal(recent.text('none'), '');
});

test('a job result says where its report was filed, or that filing failed', () => {
  const base: Job = {
    adapter: 'cli', conversationId: 'c', id: 'r-1', question: 'q?', context: '', status: 'done',
    createdAt: '2026-11-22T00:00:00Z', report: 'the report', delivered: false,
  };
  assert.doesNotMatch(frameJobResult(base, 'Rick'), /library:/);
  assert.match(frameJobResult({ ...base, library: { filedAs: 'adhd' } }, 'Rick'), /filed under topic "adhd"/);
  assert.match(frameJobResult({ ...base, library: { error: 'HTTP 500' } }, 'Rick'), /FAILED \(HTTP 500\)/);
});
