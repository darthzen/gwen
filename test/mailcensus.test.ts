import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  censusQuery,
  censusReport,
  firstMailto,
  listMessageCount,
  loadState,
  messageUrl,
  newCensusState,
  parseFrom,
  parseKeepValues,
  parseMetadataBlocks,
  parseSearchPage,
  rangeFor,
  saveState,
  SHEET_HEADER,
  sheetRows,
  statePath,
  summaryOf,
} from '../src/mailcensus.js';

const SEARCH_PAGE = [
  'Scanned 3 message(s) for after:1700000000 before:1800000000 -label:inbox',
  'Message ID: 100',
  'URL: https://mail.google.com/mail/u/0/#inbox/100',
  'Message ID: 101',
  'URL: https://mail.google.com/mail/u/0/#inbox/101',
  'Message ID: 102',
  'Next page: page_token=abc123',
].join('\n');

test('parseSearchPage: ids and the next-page token', () => {
  const { ids, pageToken } = parseSearchPage(SEARCH_PAGE);
  assert.deepEqual(ids, ['100', '101', '102']);
  assert.equal(pageToken, 'abc123');
});

test('parseSearchPage: no token on the last page', () => {
  const { ids, pageToken } = parseSearchPage(SEARCH_PAGE.replace('Next page: page_token=abc123', ''));
  assert.deepEqual(ids, ['100', '101', '102']);
  assert.equal(pageToken, null);
});

test('parseSearchPage: an empty page', () => {
  const { ids, pageToken } = parseSearchPage('Scanned 0 message(s)');
  assert.deepEqual(ids, []);
  assert.equal(pageToken, null);
});

const BATCH = [
  'Message ID: 100',
  'Subject: [rust-announce] 1.80 out',
  'From: "Rust Announce" <announce@rust-lang.org>',
  'Date: Mon, 1 Jan 2024 10:00:00 +0000',
  'List-Unsubscribe: <mailto:unsubscribe@rust-lang.org>, <https://rust-lang.org/leave>',
  'List-Id: rust-announce.rust-lang.org',
  'Message ID: 101',
  'Subject: plain mail',
  'From: friend@example.com',
  'Date: Tue, 2 Jan 2024 10:00:00 +0000',
  'Message ID: 102',
  'Subject: broken date',
  'From: "A Name" <a@example.com>',
  'Date: not a date',
  'List-Unsubscribe: <mailto:leave@example.com>',
].join('\n');

test('parseMetadataBlocks: a full block, a non-list block, an unparseable date', () => {
  const messages = parseMetadataBlocks(BATCH);
  assert.equal(messages.length, 3);
  const [first, second, third] = messages;
  assert.equal(first!.id, '100');
  assert.equal(first!.subject, '[rust-announce] 1.80 out');
  assert.deepEqual(first!.from, { name: 'Rust Announce', address: 'announce@rust-lang.org' });
  assert.equal(first!.date, Date.parse('Mon, 1 Jan 2024 10:00:00 +0000'));
  assert.equal(first!.listUnsubscribe, 'mailto:unsubscribe@rust-lang.org');
  assert.equal(first!.listId, 'rust-announce.rust-lang.org');
  assert.equal(second!.listUnsubscribe, null);
  assert.equal(second!.listId, null);
  assert.equal(third!.date, 0);
});

test('parseFrom: named, quoted and bare forms', () => {
  assert.deepEqual(parseFrom('Rust Announce <announce@rust-lang.org>'), {
    name: 'Rust Announce',
    address: 'announce@rust-lang.org',
  });
  assert.deepEqual(parseFrom('"Rust Announce" <announce@rust-lang.org>'), {
    name: 'Rust Announce',
    address: 'announce@rust-lang.org',
  });
  assert.deepEqual(parseFrom('announce@rust-lang.org'), { name: '', address: 'announce@rust-lang.org' });
  assert.deepEqual(parseFrom(''), { name: '', address: '' });
});

test('firstMailto: angle-bracket, bare mailto and plain-link forms', () => {
  assert.equal(firstMailto('<mailto:leave@example.com>'), 'mailto:leave@example.com');
  assert.equal(firstMailto('mailto:leave@example.com'), 'mailto:leave@example.com');
  assert.equal(
    firstMailto('<mailto:leave@example.com>, <https://example.com/leave>'),
    'mailto:leave@example.com',
  );
  assert.equal(firstMailto('<https://example.com/leave>'), 'https://example.com/leave');
  assert.equal(firstMailto(''), null);
});

test('messageUrl: the Gmail URL for an id', () => {
  assert.equal(messageUrl('abc-123'), 'https://mail.google.com/mail/u/0/#inbox/abc-123');
  assert.equal(messageUrl('a b+c'), 'https://mail.google.com/mail/u/0/#inbox/a%20b%2Bc');
});

test('censusQuery: the window in epoch seconds', () => {
  assert.equal(censusQuery(1700000000, 1800000000), 'after:1700000000 before:1800000000 -label:inbox');
});

const msg = (id: string, address: string, date: number, listUnsubscribe = `mailto:leave-${id}@example.com`, name = '') => ({
  id,
  subject: `subject ${id}`,
  from: { name, address },
  date,
  listUnsubscribe,
  listId: null,
  url: null,
});

test('aggregate: counts, first and last seen, unsubscribe link', () => {
  const state = newCensusState(0, 10);
  const fresh = aggregate(state, [
    msg('a', 'List@Example.com', 3000),
    msg('b', 'list@example.com', 1000),
    msg('c', 'list@example.com', 5000, null),
  ]);
  assert.deepEqual(fresh, ['a', 'b', 'c']);
  const sender = state.senders['list@example.com'];
  assert.ok(sender);
  // msg c carries no List-Unsubscribe, so it is scanned but not a list message.
  assert.equal(sender.count, 2);
  assert.equal(sender.firstSeen, 1000);
  assert.equal(sender.lastSeen, 3000);
  assert.equal(sender.listUnsubscribe, 'mailto:leave-a@example.com');
  assert.equal(sender.example.id, 'a');
  assert.equal(listMessageCount(state), 2);
  assert.equal(state.processedIds.length, 3);
  assert.equal(Object.keys(state.senders).length, 1);
});

test('aggregate: a rerun over the same ids adds nothing', () => {
  const state = newCensusState(0, 10);
  aggregate(state, [msg('a', 'list@example.com', 1000)]);
  const fresh = aggregate(state, [msg('a', 'list@example.com', 1000), msg('b', 'other@example.com', 2000)]);
  assert.deepEqual(fresh, ['b']);
  assert.equal(state.senders['list@example.com']!.count, 1);
  assert.equal(Object.keys(state.senders).length, 2);
});

test('aggregate: non-list mail is scanned but not a sender', () => {
  const state = newCensusState(0, 10);
  aggregate(state, [msg('a', 'friend@example.com', 1000, null)]);
  assert.equal(state.processedIds.length, 1);
  assert.equal(Object.keys(state.senders).length, 0);
  assert.equal(state.dateById['a'], 1000);
  assert.equal(listMessageCount(state), 0);
});

test('aggregate: list mail with no From address is unreadable', () => {
  const state = newCensusState(0, 10);
  aggregate(state, [msg('a', '', 1000)]);
  assert.equal(Object.keys(state.senders).length, 0);
  assert.equal(state.unreadable.length, 1);
  assert.equal(state.unreadable[0]!.id, 'a');
});

test('summaryOf: the numbers the finished report carries', () => {
  const state = newCensusState(1700000000, 1800000000);
  aggregate(state, [
    msg('a', 'list@example.com', 1000),
    msg('b', 'list@example.com', 2000),
    msg('c', 'friend@example.com', 3000, null),
  ]);
  state.unreadable.push({ id: 'x', reason: 'no From address' });
  state.sheetId = 'sheet-1';
  const summary = summaryOf(state);
  assert.equal(summary.messagesScanned, 3);
  assert.equal(summary.listMessages, 2);
  assert.equal(summary.senderCount, 1);
  assert.equal(summary.unreadableCount, 1);
  assert.equal(summary.sheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-1/edit');
});

test('sheetRows: header, sorted by count, Keep matched by address', () => {
  const state = newCensusState(0, 10);
  aggregate(state, [
    msg('a', 'big@example.com', 1000, 'mailto:leave-big@example.com'),
    msg('b', 'big@example.com', 2000, 'mailto:leave-big@example.com'),
    msg('c', 'small@example.com', 3000, 'mailto:leave-small@example.com'),
  ]);
  const keep = new Map([['big@example.com', 'yes']]);
  const rows = sheetRows(state, keep);
  assert.deepEqual(rows[0], SHEET_HEADER);
  assert.equal(rows.length, 3);
  assert.equal(rows[1]![2], 'big@example.com');
  assert.equal(rows[1]![0], 'yes');
  assert.equal(rows[2]![2], 'small@example.com');
  assert.equal(rows[2]![0], '');
  assert.equal(rows[1]![7], messageUrl('a'));
});

test('parseKeepValues: column A by column C address, header skipped', () => {
  const text = [
    'Keep\tName\tAddress\tCount',
    'yes\tBig List\tbig@example.com\t2',
    '\tSmall List\tsmall@example.com\t1',
    'short line',
  ].join('\n');
  const keep = parseKeepValues(text);
  assert.equal(keep.get('big@example.com'), 'yes');
  assert.equal(keep.get('small@example.com'), '');
  assert.equal(keep.size, 2);
});

test('parseKeepValues: rows with a leading row number', () => {
  const text = [
    '1\tKeep\tName\tAddress\tCount',
    '2\tyes\tBig List\tbig@example.com\t2',
    '3\t\tSmall List\tsmall@example.com\t1',
  ].join('\n');
  const keep = parseKeepValues(text);
  assert.equal(keep.get('big@example.com'), 'yes');
  assert.equal(keep.get('small@example.com'), '');
  assert.equal(keep.size, 2);
});

test('Keep survives a rewrite: marked rows keep their mark, new senders start blank', () => {
  const state = newCensusState(0, 10);
  aggregate(state, [
    msg('a', 'big@example.com', 1000, 'mailto:leave-big@example.com'),
    msg('b', 'big@example.com', 2000, 'mailto:leave-big@example.com'),
    msg('c', 'small@example.com', 3000, 'mailto:leave-small@example.com'),
  ]);
  const first = sheetRows(state, new Map());
  const keep = parseKeepValues(first.map((r) => r.join('\t')).join('\n'));
  keep.set('big@example.com', 'yes');
  // A later run: the same two senders plus a new one.
  aggregate(state, [msg('d', 'new@example.com', 4000, 'mailto:leave-new@example.com')]);
  const second = sheetRows(state, keep);
  const byAddress = new Map(second.slice(1).map((r) => [r[2]!, r[0]!]));
  assert.equal(byAddress.get('big@example.com'), 'yes');
  assert.equal(byAddress.get('small@example.com'), '');
  assert.equal(byAddress.get('new@example.com'), '');
});

test('rangeFor: the range that covers the rows', () => {
  assert.equal(rangeFor(10, SHEET_HEADER.length), 'A1:I10');
  assert.equal(rangeFor(1, 9), 'A1:I1');
});

test('state save and load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    assert.equal(loadState(dir), null);
    const state = newCensusState(1700000000, 1800000000);
    aggregate(state, [msg('a', 'list@example.com', 1000)]);
    state.sheetId = 'sheet-1';
    state.coveredThrough = 1000;
    saveState(dir, state);
    assert.ok(statePath(dir).endsWith('mail-census.json'));
    const loaded = loadState(dir);
    assert.ok(loaded);
    assert.equal(loaded.windowStart, 1700000000);
    assert.equal(loaded.windowEnd, 1800000000);
    assert.equal(loaded.processedIds.length, 1);
    assert.equal(loaded.senders['list@example.com']!.count, 1);
    assert.equal(loaded.sheetId, 'sheet-1');
    assert.equal(loaded.coveredThrough, 1000);
    assert.equal(loaded.finishedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('censusReport: the finished summary as text', () => {
  const job = {
    id: 'mc-test',
    question: '',
    context: '',
    status: 'done' as const,
    createdAt: '',
    delivered: true,
    report: JSON.stringify({
      windowStart: 1700000000,
      windowEnd: 1800000000,
      messagesScanned: 42,
      listMessages: 10,
      senderCount: 3,
      unreadableCount: 1,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      sheetId: 'sheet-1',
    }),
  };
  const report = censusReport(job);
  assert.match(report, /^status: finished$/m);
  assert.match(report, /messages scanned: 42/);
  assert.match(report, /mailing-list messages: 10/);
  assert.match(report, /senders: 3/);
  assert.match(report, /unreadable: 1/);
  assert.match(report, /sheet: https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-1\/edit/);
  assert.match(report, /^window: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/m);
});
