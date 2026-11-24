import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, Handoffs, frameCapped, frameInterrupted, frameResume, handoffDirective, itemsAdded } from '../src/handoff.js';
import { Store } from '../src/store.js';

const round = (inputTokens = 1000, calls = 1) => ({
  text: '',
  toolCalls: Array(calls).fill({}),
  toolResults: Array(calls).fill({}),
  usage: { inputTokens },
});
const limits = { maxSteps: 5, inputTokens: 100_000, items: 80 };
const target = { adapter: 'cli', conversationId: 'cli:local', replyRef: null };
const dataDir = () => mkdtempSync(join(tmpdir(), 'gwen-handoff-'));

test('a run inside every limit is not stopped', () => {
  const budget = new Budget(limits);
  assert.equal(budget.stopWhen({ steps: [round(), round()] }), false);
  assert.equal(budget.reason, undefined);
  assert.equal(budget.handedOff(3), false);
});

test('the step limit stops the run', () => {
  const budget = new Budget(limits);
  assert.equal(budget.stopWhen({ steps: Array(5).fill(round()) }), true);
  assert.equal(budget.reason, 'steps');
});

test('the token limit reads the newest round, not the sum', () => {
  const summed = new Budget(limits);
  assert.equal(summed.stopWhen({ steps: [round(60_000), round(60_000)] }), false);
  const full = new Budget(limits);
  assert.equal(full.stopWhen({ steps: [round(1000), round(100_000)] }), true);
  assert.equal(full.reason, 'tokens');
});

test('the item limit counts what this run added', () => {
  // 1 input + 4 rounds of 10 calls and 10 results = 81 items.
  const steps = Array(4).fill(round(1000, 10));
  assert.equal(itemsAdded(steps), 81);
  const budget = new Budget(limits);
  assert.equal(budget.stopWhen({ steps }), true);
  assert.equal(budget.reason, 'items');
});

test('a limit of 0 is off', () => {
  const budget = new Budget({ maxSteps: 50, inputTokens: 0, items: 0 });
  assert.equal(budget.stopWhen({ steps: Array(10).fill(round(250_000, 10)) }), false);
});

test('only the forced final request counts as a handoff', () => {
  const budget = new Budget(limits);
  budget.stopWhen({ steps: Array(5).fill(round()) });
  // 5 tool rounds, then a plain-text answer: the task finished at the limit.
  assert.equal(budget.handedOff(6), false);
  // 5 tool rounds, a 6th response still calling tools, then the forced note.
  assert.equal(budget.handedOff(7), true);
});

test('a note is saved for reading, kept in history, and left pending', () => {
  const dir = dataDir();
  const handoffs = new Handoffs(dir, { maxResumes: 2, inputTokens: 0, items: 0 });
  const pending = handoffs.save(target, 'Task: write the spec', 'steps', 0, new Date('2026-11-24T22:00:00Z'));
  assert.equal(pending.resume, 1);
  assert.equal(pending.capped, false);
  assert.equal(readFileSync(join(dir, 'handoffs', 'cli_local.md'), 'utf8'), 'Task: write the spec\n');
  assert.ok(existsSync(join(dir, 'handoffs', 'cli_local.20261124T220000Z.md')));
  assert.deepEqual(handoffs.pending('cli:local'), pending);
  assert.deepEqual(handoffs.all(), [pending]);
  handoffs.clear('cli:local');
  assert.equal(handoffs.pending('cli:local'), undefined);
  assert.deepEqual(handoffs.all(), []);
});

test('the resume limit caps the chain, and a person starts the count again', () => {
  const handoffs = new Handoffs(dataDir(), { maxResumes: 2, inputTokens: 0, items: 0 });
  assert.equal(handoffs.save(target, 'n', 'steps', 1).capped, false);
  assert.equal(handoffs.save(target, 'n', 'steps', 2).capped, true);
  const second = handoffs.save(target, 'n', 'tokens', 1);
  assert.equal(second.resume, 2);
  handoffs.restart('cli:local');
  assert.equal(handoffs.pending('cli:local')?.resume, 1);
  assert.equal(handoffs.pending('cli:local')?.id, second.id);
});

test('maxResumes 0 turns handoff off', () => {
  assert.equal(new Handoffs(dataDir(), { maxResumes: 0, inputTokens: 0, items: 0 }).enabled, false);
});

test('framing carries the note and says what happens next', () => {
  const handoffs = new Handoffs(dataDir(), { maxResumes: 1, inputTokens: 0, items: 0 });
  const live = handoffs.save(target, 'NOTE BODY', 'steps', 0);
  const capped = handoffs.save(target, 'NOTE BODY', 'steps', 1);
  assert.match(frameResume(live, 1, 'Rick'), /^\[Automatic resume 1 of 1\..*\]\n\nNOTE BODY$/s);
  assert.match(frameInterrupted(live), /cancel_resume/);
  assert.doesNotMatch(frameInterrupted(capped), /cancel_resume/);
  assert.match(frameCapped(capped, 1), /after 1 automatic resumes.*NOTE BODY/s);
  assert.match(handoffDirective('Rick'), /what Rick asked for/);
});

test('retiring a conversation moves its state to backup', () => {
  const dir = dataDir();
  const store = new Store(dir);
  assert.equal(store.retire('cli:local', 'handoff-x'), undefined);
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  writeFileSync(join(dir, 'conversations', 'cli_local.json'), '{}');
  const to = store.retire('cli:local', 'handoff-x');
  assert.equal(to, join(dir, 'backup', 'cli_local.handoff-x.json'));
  assert.deepEqual(readdirSync(join(dir, 'conversations')), []);
  assert.ok(existsSync(to!));
});
