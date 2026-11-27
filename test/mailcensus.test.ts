import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  censusQuery,
  censusReport,
  frameCensusResult,
  loadState,
  messageUrl,
  newCensusState,
  parseFrom,
  parseKeepValues,
  parseFoundCount,
  parseMetadataBlocks,
  parseRetrievedCount,
  parseSearchPage,
  saveState,
  SHEET_HEADER,
  SHEET_READ_ROWS,
  sheetRows,
  statePath,
  summaryOf,
  unsubscribeLink,
  type ParsedMessage,
} from '../src/mailcensus.js';
import { MailCensus } from '../src/mailcensus.js';
import { frameCensusResult } from '../src/frame.js';
import { CREATE_SHEET, EMPTY_PAGE, LAST_PAGE, METADATA, READ_SHEET, SEARCH_PAGE } from './fixtures-mailcensus.js';
import { Store } from '../src/store.js';
import type { Job } from '../src/store.js';
import type { ReplyTarget } from '../src/adapters/types.js';

// --- Parsers against the real captured output ------------------------------

test('parseSearchPage: a real page, ids, web links and the next-page token', () => {
  const { ids, urls, pageToken } = parseSearchPage(SEARCH_PAGE);
  assert.equal(ids.length, 15);
  assert.equal(ids[0], '1a20ff91ecf7612b');
  assert.equal(ids[14], '1a20fa4baf6d2f75');
  assert.equal(urls.get('1a20ff91ecf7612b'), 'https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff91ecf7612b');
  assert.equal(pageToken, '13399976901664959792');
});

test('parseSearchPage: the last page has no token', () => {
  const { ids, pageToken } = parseSearchPage(LAST_PAGE);
  assert.equal(ids.length, 3);
  assert.equal(pageToken, null);
});

test('parseSearchPage: an empty page', () => {
  const { ids, pageToken } = parseSearchPage(EMPTY_PAGE);
  assert.deepEqual(ids, []);
  assert.equal(pageToken, null);
});

test('parseMetadataBlocks: a real batch, five messages', () => {
  const messages = parseMetadataBlocks(METADATA);
  assert.equal(messages.length, 5);
  const [first, last] = [messages[0]!, messages[4]!];
  assert.equal(first.id, '1a20ff91ecf7612b');
  assert.equal(first.subject, 'A surprise waiting for you');
  assert.deepEqual(first.from, { name: 'AliExpress', address: 'ae-editor-pick04@selections.aliexpress.com' });
  assert.equal(first.date, Date.parse('Wed, 25 Nov 2026 07:51:52 +0800'));
  assert.equal(first.listUnsubscribe, null);
  assert.equal(first.url, 'https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20ff91ecf7612b');
  // The one list message: an https-only List-Unsubscribe, no mailto.
  assert.equal(last.id, '1a20fed758783781');
  assert.deepEqual(last.from, { name: 'Ben - Talking Point Cards', address: 'support@talkingpointcards.com' });
  assert.ok(last.listUnsubscribe);
  assert.ok(last.listUnsubscribe!.startsWith('https://manage.kmail-lists.com/subscriptions/unsubscribe'));
  assert.equal(last.url, 'https://mail.google.com/mail/?authuser=rick@theashfords.org#all/1a20fed758783781');
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

test('unsubscribeLink: https first, mailto second, raw value last', () => {
  assert.equal(
    unsubscribeLink('<https://rust-lang.org/leave>, <mailto:unsubscribe@rust-lang.org>'),
    'https://rust-lang.org/leave',
  );
  assert.equal(unsubscribeLink('<mailto:unsubscribe@rust-lang.org>'), 'mailto:unsubscribe@rust-lang.org');
  assert.equal(
    unsubscribeLink('<mailto:leave@example.com>, <https://example.com/leave>'),
    'https://example.com/leave',
  );
  assert.equal(unsubscribeLink('https://example.com/leave'), 'https://example.com/leave');
  assert.equal(unsubscribeLink(''), null);
});

test('censusQuery: the slice window, everything received minus sent, drafts and chats', () => {
  assert.equal(censusQuery(1700000000, 1800000000), 'after:1700000000 before:1800000000 -in:sent -in:drafts -in:chats');
});

// --- Aggregation ------------------------------------------------------------

const msg = (
  id: string,
  address: string,
  date: number,
  listUnsubscribe: string | null = `mailto:leave-${id}@example.com`,
  name = '',
  url: string | null = null,
): ParsedMessage => ({
  id,
  subject: `subject ${id}`,
  from: { name, address },
  date,
  listUnsubscribe,
  listId: null,
  url,
});

test('aggregate: counts, first and last seen, unsubscribe link', () => {
  const state = newCensusState();
  const list = aggregate(state, [
    msg('a', 'List@Example.com', 3000),
    msg('b', 'list@example.com', 1000),
    msg('c', 'list@example.com', 5000, null),
  ]);
  assert.equal(list, 2);
  const sender = state.senders['list@example.com'];
  assert.ok(sender);
  assert.equal(sender.count, 2);
  assert.equal(sender.firstSeen, 1000);
  assert.equal(sender.lastSeen, 3000);
  assert.equal(sender.listUnsubscribe, 'mailto:leave-a@example.com');
  assert.equal(sender.example.id, 'a');
  assert.equal(state.listMessages, 2);
  assert.equal(state.messagesScanned, 3);
  assert.equal(Object.keys(state.senders).length, 1);
});

test('aggregate: non-list mail is scanned but not a sender', () => {
  const state = newCensusState();
  aggregate(state, [msg('a', 'friend@example.com', 1000, null)]);
  assert.equal(state.messagesScanned, 1);
  assert.equal(Object.keys(state.senders).length, 0);
  assert.equal(state.listMessages, 0);
});

test('aggregate: list mail with no From address is unreadable, counted once', () => {
  const state = newCensusState();
  aggregate(state, [msg('a', '', 1000)]);
  assert.equal(Object.keys(state.senders).length, 0);
  assert.equal(state.unreadableTotal, 1);
});

// --- The sheet --------------------------------------------------------------

test('summaryOf: the numbers the finished report carries', () => {
  const state = newCensusState();
  state.coveredAfter = 1700000000;
  state.coveredBefore = 1800000000;
  aggregate(state, [
    msg('a', 'list@example.com', 1000),
    msg('b', 'list@example.com', 2000),
    msg('c', 'friend@example.com', 3000, null),
  ]);
  state.unreadableTotal = 1;
  state.sheetId = 'sheet-1';
  const summary = summaryOf(state, 1);
  assert.equal(summary.coveredAfter, 1700000000);
  assert.equal(summary.coveredBefore, 1800000000);
  assert.equal(summary.messagesScanned, 3);
  assert.equal(summary.listMessages, 2);
  assert.equal(summary.senderCount, 1);
  assert.equal(summary.unreadableThisRun, 1);
  assert.equal(summary.unreadableTotal, 1);
  assert.equal(summary.sheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-1/edit');
});

test('sheetRows: header, sorted by count, Keep matched by address', () => {
  const state = newCensusState();
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
  assert.equal(rows[1]![3], '2');
  assert.equal(rows[2]![2], 'small@example.com');
  assert.equal(rows[2]![0], '');
  assert.equal(rows[1]![7], messageUrl('a'));
});

test('parseKeepValues: the real read_sheet_values format, row number first', () => {
  const keep = parseKeepValues(READ_SHEET);
  // Rick's existing sheet has no Keep column: the name in column B is the
  // label, and the address in column C is what we match back on.
  assert.equal(keep.get('jobalerts-noreply@linkedin.com'), 'LinkedIn Job Alerts');
  assert.equal(keep.get('notifications-noreply@linkedin.com'), 'LinkedIn Notifications');
  assert.equal(keep.size, 4);
});

test('parseKeepValues: the census sheet shape, marks survive the round trip', () => {
  const state = newCensusState();
  aggregate(state, [
    msg('a', 'big@example.com', 1000, 'mailto:leave-big@example.com'),
    msg('b', 'big@example.com', 2000, 'mailto:leave-big@example.com'),
    msg('c', 'small@example.com', 3000, 'mailto:leave-small@example.com'),
  ]);
  const first = sheetRows(state, new Map());
  const read = first.map((r, i) => `${i + 1}\t${r.join('\t')}`).join('\n');
  const keep = parseKeepValues(read);
  keep.set('big@example.com', 'yes');
  aggregate(state, [msg('d', 'new@example.com', 4000, 'mailto:leave-new@example.com')]);
  const second = sheetRows(state, keep);
  const byAddress = new Map(second.slice(1).map((r) => [r[2]!, r[0]!]));
  assert.equal(byAddress.get('big@example.com'), 'yes');
  assert.equal(byAddress.get('small@example.com'), '');
  assert.equal(byAddress.get('new@example.com'), '');
});

// --- State file -------------------------------------------------------------

test('state save and load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    assert.equal(loadState(dir), null);
    const state = newCensusState();
    state.coveredAfter = 1700000000;
    state.coveredBefore = 1800000000;
    aggregate(state, [msg('a', 'list@example.com', 1000)]);
    state.sheetId = 'sheet-1';
    saveState(dir, state);
    assert.ok(statePath(dir).endsWith('mail-census.json'));
    const loaded = loadState(dir);
    assert.ok(loaded);
    assert.equal(loaded.coveredAfter, 1700000000);
    assert.equal(loaded.coveredBefore, 1800000000);
    assert.equal(loaded.senders['list@example.com']!.count, 1);
    assert.equal(loaded.sheetId, 'sheet-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Reports and framing ----------------------------------------------------

const jobWith = (report: string, status: 'done' | 'failed' = 'done'): Job => ({
  id: 'mc-test',
  conversationId: 'c1',
  adapter: 'telegram',
  question: '',
  context: '',
  status,
  createdAt: '',
  delivered: true,
  report,
});

test('censusReport: the finished summary as text', () => {
  const job = jobWith(
    JSON.stringify({
      coveredAfter: 1700000000,
      coveredBefore: 1800000000,
      messagesScanned: 42,
      listMessages: 10,
      senderCount: 3,
      unreadableTotal: 1,
      unreadableThisRun: 0,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      sheetId: 'sheet-1',
    }),
  );
  const report = censusReport(job);
  assert.match(report, /^status: finished$/m);
  assert.match(report, /messages scanned: 42/);
  assert.match(report, /mailing-list messages: 10/);
  assert.match(report, /senders: 3/);
  assert.match(report, /unreadable: 0 in this run, 1 in total/);
  assert.match(report, /sheet: https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-1\/edit/);
  assert.match(report, /^covered: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/m);
});

test('frameCensusResult: the sheet URL must be relayed verbatim', () => {
  const job = jobWith(
    JSON.stringify({
      coveredAfter: 1700000000,
      coveredBefore: 1800000000,
      messagesScanned: 42,
      listMessages: 10,
      senderCount: 3,
      unreadableTotal: 0,
      unreadableThisRun: 0,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      sheetId: 'sheet-1',
    }),
  );
  const frame = frameCensusResult(job, 'Rick');
  assert.match(frame, /mail census result/);
  assert.match(frame, /status: finished/);
  assert.match(frame, /https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-1\/edit/);
  assert.match(frame, /on its own line/);
  assert.match(frame, /verbatim/);
  assert.doesNotMatch(frame, /background research/);
});

// --- Integration: MailCensus against a fake MCP -----------------------------
//
// The fake validates every argument name against the real tool schemas
// (workspace-mcp v2.6.0, captured 2026-11-27):
//   search_gmail_messages       user_google_email, query, page_size, page_token
//   get_gmail_messages_content_batch  user_google_email, message_ids, format
//   create_spreadsheet          user_google_email, title, sheet_names
//   read_sheet_values           user_google_email, spreadsheet_id, range_name
//   modify_sheet_values         user_google_email, spreadsheet_id, range_name, values, value_input_option
// Its replies are the captured output shapes from test/fixtures-mailcensus.ts.

const DAY = 86_400;
const T0 = 1700000000; // 2023-11-14T22:13:20Z, a Tuesday midnight in UTC

/** One day of fake mail: one list message and one plain message. */
function dayPage(day: number, empty = false): { text: string; ids: string[] } {
  if (empty) return { text: EMPTY_SEARCH, ids: [] };
  const id = `fake${String(day).padStart(4, '0')}`;
  const plain = `fake${String(day).padStart(4, '0')}p`;
  const web = (mid: string) => `https://mail.google.com/mail/?authuser=rick@theashfords.org#all/${mid}`;
  const text = [
    `Found 2 messages matching 'after:${T0 + day * DAY} before:${T0 + (day + 1) * DAY} -in:sent -in:drafts -in:chats':`,
    '',
    '📧 MESSAGES:',
    `  1. Message ID: ${id}`,
    `     Web Link: ${web(id)}`,
    `     Thread ID: ${id}`,
    `     Thread Link: ${web(id)}`,
    '',
    `  2. Message ID: ${plain}`,
    `     Web Link: ${web(plain)}`,
    `     Thread ID: ${plain}`,
    `     Thread Link: ${web(plain)}`,
    '',
    '💡 USAGE:',
    '  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()',
    "    e.g. get_gmail_messages_content_batch(message_ids=[...])",
    '  • Pass the Thread IDs to get_gmail_thread_content() (single) or get_gmail_threads_content_batch() (batch)',
    '',
  ].join('\n');
  return { text, ids: [id, plain] };
}

function dayMetadata(day: number): string {
  const id = `fake${String(day).padStart(4, '0')}`;
  const plain = `fake${String(day).padStart(4, '0')}p`;
  const web = (mid: string) => `https://mail.google.com/mail/?authuser=rick@theashfords.org#all/${mid}`;
  const date = new Date((T0 + day * DAY + 3600) * 1000).toUTCString();
  return [
    'Retrieved 2 messages:',
    '',
    `Message ID: ${id}`,
    'Subject: [Test List] daily',
    'From: Test List <list@example.com>',
    `Date: ${date}`,
    `Message-ID: <${id}@example.com>`,
    'To: rick@theashfords.org',
    'List-Unsubscribe: <https://lists.example.com/leave>, <mailto:leave@example.com>',
    `Web Link: ${web(id)}`,
    '',
    '---',
    '',
    `Message ID: ${plain}`,
    'Subject: a normal mail',
    'From: Friend <friend@example.com>',
    `Date: ${date}`,
    `Message-ID: <${plain}@example.com>`,
    'To: rick@theashfords.org',
    `Web Link: ${web(plain)}`,
    '',
  ].join('\n');
}

const EMPTY_SEARCH = [
  'Found 0 messages matching the query:',
  '',
  '📧 MESSAGES:',
  '',
  '💡 USAGE:',
  '  • Pass the Message IDs **as a list** to get_gmail_messages_content_batch()',
  '',
].join('\n');

interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

class FakeWorkspace {
  calls: FakeCall[] = [];
  sheetId = 'fake-sheet-id';
  private rows: string[][] = [];
  /** The stored sheet, row by row. Reads return what is actually stored. */
  get sheetRows(): string[][] {
    return this.rows;
  }
  /** When set, the named tool rejects its call. */
  fail: { tool: string; error: string } | null = null;
  /** When set, read_sheet_values rejects its call. */
  failRead = false;
  /**
   * The count the fake's pages claim on their first line, overriding the
   * ids it actually prints: a mismatch the census must catch. null = honest.
   */
  foundCount: number | null = null;
  private pageDays: number[] = [];
  private pageIdx = 0;
  /** Days after this are empty (the test sets it before a search). */
  emptyAfterDays: number | null = null;
  private nextPage(): string {
    const day = this.pageDays[this.pageIdx++]!;
    // The live server prints the PAGINATION line only when a next page
    // exists; an empty page ends the walk.
    const { text, ids } = dayPage(day, this.emptyAfterDays !== null && day >= this.emptyAfterDays);
    // The live server prints the PAGINATION line only when a next page
    // exists; an empty page ends the walk.
    if (ids.length === 0 || this.pageIdx >= this.pageDays.length) return this.pageResult(text);
    return this.pageResult(text + `\n\n📄 PAGINATION: To get the next page, call search_gmail_messages again with page_token='${this.pageIdx}'`);
  }

  /** The hub wraps every tool text in { result: "<text>" } (verified live). */
  private pageResult(text: string): { result: string } {
    if (this.foundCount === null) return { result: text };
    return { result: text.replace(/^Found \d+ messages/m, `Found ${this.foundCount} messages`) };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    if (this.fail && this.fail.tool === tool) throw new Error(this.fail.error);
    const known: Record<string, string[]> = {
      search_gmail_messages: ['user_google_email', 'query', 'page_size', 'page_token'],
      get_gmail_messages_content_batch: ['user_google_email', 'message_ids', 'format'],
      create_spreadsheet: ['user_google_email', 'title', 'sheet_names'],
      read_sheet_values: ['user_google_email', 'spreadsheet_id', 'range_name'],
      modify_sheet_values: ['user_google_email', 'spreadsheet_id', 'range_name', 'values', 'value_input_option'],
    };
    const allowed = known[tool];
    assert.ok(allowed, `fake MCP saw an unknown tool ${tool}`);
    for (const key of Object.keys(args)) assert.ok(allowed.includes(key), `fake MCP saw an unknown argument ${key} for ${tool}`);
    for (const key of ['user_google_email']) assert.equal(args[key], 'rick@theashfords.org', `${tool} must pass user_google_email`);

    switch (tool) {
      case 'search_gmail_messages': {
        const m = String(args.query).match(/^after:(\d+) before:(\d+) -in:sent -in:drafts -in:chats$/);
        assert.ok(m, `unexpected query: ${args.query}`);
        const start = Number(m![1]);
        const end = Number(m![2]);
        // Simulate the live server's paging: one day of IDs per page, the
        // continuation token on a PAGINATION line in single quotes.
        if (args.page_token === undefined) {
          this.pageDays = [];
          for (let s = start; s < end; s += DAY) this.pageDays.push(s - T0);
          this.pageIdx = 0;
        } else {
          this.pageIdx = Number(args.page_token);
        }
        return this.nextPage();
      }
      case 'get_gmail_messages_content_batch': {
        const ids = args.message_ids as string[];
        assert.ok(Array.isArray(ids) && ids.length > 0 && ids.length <= 100);
        assert.equal(args.format, 'metadata');
        const day = Number(ids[0]!.replace(/[^0-9]/g, '').slice(-4));
        return { result: dayMetadata(day) };
      }
      case 'create_spreadsheet':
        assert.equal(args.title, 'Mailing list census');
        return { result: CREATE_SHEET.replace('14d-oozhS6zDNpW8FNphvtnzUzihjjArFhvfq4ZPobgk', this.sheetId) };
      case 'read_sheet_values': {
        if (this.failRead) throw new Error('read_sheet_values timed out');
        assert.equal(args.spreadsheet_id, this.sheetId);
        const range = String(args.range_name);
        assert.ok(/^A\d+:C\d+$/.test(range), `expected chunked A:C ranges, got ${range}`);
        const startRow = Number(range.slice(1, range.indexOf(':')));
        const endRow = Number(range.slice(range.indexOf(':') + 1).replace(/^[A-Z]+/, ''));
        assert.ok(endRow - startRow + 1 <= SHEET_READ_ROWS, 'a chunk is at most 1000 rows');
        // The census reads A:C only, so mirror that: the row number plus the
        // first three cells.
        const lines = this.sheetRows.slice(startRow - 1, endRow).map((r, i) => `${startRow + i}\t${r.slice(0, 3).join('\t')}`);
        return { result: `Successfully read ${lines.length} rows from range '${range}':\nEach line: sheet row number, then tab-separated cells from column A.\n${lines.join('\n')}` };
      }
      case 'modify_sheet_values': {
        assert.equal(args.spreadsheet_id, this.sheetId);
        assert.equal(args.range_name, 'A1', 'range_name is the top-left cell only');
        assert.equal(args.value_input_option, 'RAW');
        const values = args.values as string[][];
        assert.ok(Array.isArray(values) && values.length > 0);
        for (const row of values) {
          assert.ok(Array.isArray(row));
          for (const cell of row) assert.equal(typeof cell, 'string', 'values are all strings');
        }
        this.rows = values;
        return { result: `Successfully updated range 'A1' in spreadsheet ${this.sheetId}. Updated: ${values.flat().length} cells, ${values.length} rows, ${values[0]!.length} columns.` };
      }
    }
    throw new Error(`unhandled tool ${tool}`);
  }
}

const target: ReplyTarget = { conversationId: 'c1', adapter: 'telegram', chatId: '1' };

function makeStore(dir: string): Store {
  return new Store(dir);
}

function makeCensus(dir: string, fake: FakeWorkspace): MailCensus {
  return new MailCensus(dir,
    { email: 'rick@theashfords.org', mcpServer: 'workspace', sheetName: 'Mailing list census' },
    (tool, args) => fake.call(tool, args),
    makeStore(dir),
    () => {},
  );
}

test('integration: a 3-day walk covers the range, writes the sheet, settles done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    const job = census.start(target, T0, T0 + 3 * DAY);
    await census.idle();
    assert.equal(job.status, 'done');
    assert.ok(job.report);
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.coveredAfter, T0);
    assert.equal(summary.coveredBefore, T0 + 3 * DAY);
    assert.equal(summary.messagesScanned, 6);
    assert.equal(summary.listMessages, 3);
    assert.equal(summary.senderCount, 1);
    assert.equal(summary.sheetUrl, `https://docs.google.com/spreadsheets/d/${fake.sheetId}/edit`);
    const state = loadState(dir)!;
    assert.equal(state.coveredBefore, T0 + 3 * DAY);
    assert.equal(state.sheetId, fake.sheetId);
    assert.equal(state.senders['list@example.com']!.count, 3);
    // The sheet: header plus the list sender, count as a string, https unsubscribe first.
    assert.deepEqual(fake.sheetRows[0], SHEET_HEADER);
    assert.equal(fake.sheetRows[1]![2], 'list@example.com');
    assert.equal(fake.sheetRows[1]![3], '3');
    assert.equal(fake.sheetRows[1]![6], 'https://lists.example.com/leave');
    // Every MCP call used the real argument names (validated in FakeWorkspace).
    assert.ok(fake.calls.some((c) => c.tool === 'create_spreadsheet'));
    assert.ok(fake.calls.every((c) => c.args.user_google_email === 'rick@theashfords.org'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a failing MCP call settles the job as failed, not done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    fake.fail = { tool: 'create_spreadsheet', error: 'drive: quotaExceeded' };
    const census = makeCensus(dir, fake);
    const job = census.start(target, T0, T0 + DAY);
    await census.idle();
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /quotaExceeded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a rerun over covered ground is a no-op that rewrites the sheet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    const searches = fake.calls.filter((c) => c.tool === 'search_gmail_messages').length;
    // The walk itself: two days, two searches.
    assert.equal(searches, 2);
    // A second run over the same window: covered, so no new searches, but the
    // sheet is rewritten and the counts are not doubled.
    const job2 = census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    assert.equal(job2.status, 'done');
    assert.equal(fake.calls.filter((c) => c.tool === 'search_gmail_messages').length, searches);
    const summary2 = JSON.parse(job2.report!) as Record<string, unknown>;
    assert.equal(summary2.messagesScanned, 4);
    assert.equal(summary2.listMessages, 2);
    assert.equal(fake.sheetRows[1]![3], '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: an extension run keeps the counts and the Keep marks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    // Rick marks the sender to keep, in the sheet's column A. The fake's
    // read_sheet_values returns what is actually stored, so the next run
    // sees the mark.
    assert.ok(fake.sheetRows[1]);
    fake.sheetRows[1]![0] = 'yes';
    // The next run extends coverage by one day.
    const job = census.start(target, T0 + 2 * DAY, T0 + 3 * DAY);
    await census.idle();
    assert.equal(job.status, 'done');
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.coveredAfter, T0);
    assert.equal(summary.coveredBefore, T0 + 3 * DAY);
    assert.equal(summary.listMessages, 3);
    // The mark survived the rewrite.
    assert.equal(fake.sheetRows[1]![0], 'yes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a gap in the coverage is refused, naming the working date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    const job = census.start(target, T0 + 5 * DAY, T0 + 6 * DAY);
    await census.idle();
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /contiguous/);
    assert.match(job.error ?? '', /gap-free/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a failed sheet read fails the run and leaves the sheet alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    const before = fake.sheetRows.map((r) => [...r]);
    fake.failRead = true;
    const job = census.start(target, T0 + 2 * DAY, T0 + 3 * DAY);
    await census.idle();
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /read_sheet_values timed out/);
    // The sheet was never rewritten with blank marks.
    assert.deepEqual(fake.sheetRows, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a window with zero messages still settles done and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    // A slice wider than one day with no mail in it.
    fake.emptyAfterDays = T0 + 1000 * DAY - T0;
    const job = census.start(target, T0 + 1000 * DAY, T0 + 1000 * DAY + 2 * DAY);
    await census.idle();
    assert.equal(job.status, 'done');
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.messagesScanned, 0);
    assert.equal(summary.listMessages, 0);
    assert.equal(summary.coveredAfter, T0 + 1000 * DAY);
    assert.equal(summary.coveredBefore, T0 + 1000 * DAY + 2 * DAY);
    assert.equal(fake.sheetRows.length, 1, 'header only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Round 3: backfill and provable empties --------------------------------

test('parseFoundCount and parseRetrievedCount: the server\'s own claims', () => {
  assert.equal(parseFoundCount('Found 2 messages matching \'x\':\n'), 2);
  assert.equal(parseFoundCount(EMPTY_SEARCH), 0);
  assert.throws(() => parseFoundCount('no count line'));
  assert.equal(parseRetrievedCount('Retrieved 2 messages:\n'), 2);
  assert.throws(() => parseRetrievedCount('no count line'));
});

test('integration: a page whose Found count disagrees fails the job, coverage does not advance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + DAY);
    await census.idle();
    // The next run\'s pages claim 3 messages but print 2.
    fake.foundCount = 3;
    const job = census.start(target, T0 + DAY, T0 + 2 * DAY);
    await census.idle();
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /claims 3 messages/);
    const state = loadState(dir)!;
    assert.equal(state.coveredBefore, T0 + DAY, 'the failed slice did not advance coverage');
    assert.equal(state.messagesScanned, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: backfill scans [start, coveredAfter) newest-to-oldest and extends coverage backwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    const queriesBefore = fake.calls.filter((c) => c.tool === 'search_gmail_messages').map((c) => String(c.args.query));
    // A run that reaches 2 days into the past.
    const job = census.start(target, T0 - 2 * DAY, T0 + 2 * DAY);
    await census.idle();
    assert.equal(job.status, 'done');
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.coveredAfter, T0 - 2 * DAY);
    assert.equal(summary.coveredBefore, T0 + 2 * DAY);
    assert.equal(summary.messagesScanned, 8);
    assert.equal(summary.listMessages, 4);
    const queries = fake.calls.filter((c) => c.tool === 'search_gmail_messages').map((c) => String(c.args.query));
    // The backfill part came after the first run's searches: one slice
    // [T0-2d, coveredAfter) = [T0-2d, T0), the missing days only. Each
    // query appears twice: the second attempt follows a deliberately
    // failed Keep read, which must not have committed the slice (the
    // second attempt does).
    const tail = queries.slice(queriesBefore.length);
    assert.deepEqual(tail, [
      `after:${T0 - 2 * DAY} before:${T0} -in:sent -in:drafts -in:chats`,
      `after:${T0 - 2 * DAY} before:${T0} -in:sent -in:drafts -in:chats`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: backfill and forward extension in one run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    const queriesBefore = fake.calls.filter((c) => c.tool === 'search_gmail_messages').length;
    const job = census.start(target, T0 - 2 * DAY, T0 + 4 * DAY);
    await census.idle();
    assert.equal(job.status, 'done');
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.coveredAfter, T0 - 2 * DAY);
    assert.equal(summary.coveredBefore, T0 + 4 * DAY);
    // The backfill slice rescans the covered middle (it must end at
    // coveredAfter), so the totals count it: 12 scanned, 6 list mail.
    assert.equal(summary.messagesScanned, 12);
    assert.equal(summary.listMessages, 6);
    const queries = fake.calls.filter((c) => c.tool === 'search_gmail_messages').map((c) => String(c.args.query)).slice(queriesBefore);
    // Backfill first: one slice [T0-2d, T0+2d) (the covered middle is
    // rescanned because the slice must end at coveredAfter), then the
    // forward part (one slice [T0+2d, T0+4d)). Each query appears twice:
    // the second attempt follows a deliberately failed Keep read, which
    // must not have committed the slice (the second attempt does).
    assert.deepEqual(queries, [
      `after:${T0 - 2 * DAY} before:${T0} -in:sent -in:drafts -in:chats`,
      `after:${T0 - 2 * DAY} before:${T0} -in:sent -in:drafts -in:chats`,
      `after:${T0 + 2 * DAY} before:${T0 + 4 * DAY} -in:sent -in:drafts -in:chats`,
      `after:${T0 + 2 * DAY} before:${T0 + 4 * DAY} -in:sent -in:drafts -in:chats`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: a restart mid-backfill continues from the state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailcensus-'));
  try {
    const fake = new FakeWorkspace();
    const census = makeCensus(dir, fake);
    census.start(target, T0, T0 + 2 * DAY);
    await census.idle();
    // Run 1 of the backfill: two days into the past.
    census.start(target, T0 - 2 * DAY, T0 + 2 * DAY);
    await census.idle();
    const state = loadState(dir)!;
    assert.equal(state.coveredAfter, T0 - 2 * DAY);
    assert.equal(state.coveredBefore, T0 + 2 * DAY);
    const searchesBefore = fake.calls.filter((c) => c.tool === 'search_gmail_messages').length;
    // The process dies; a new instance continues the backfill further back.
    const census2 = makeCensus(dir, fake);
    const job = census2.start(target, T0 - 4 * DAY, T0 + 2 * DAY);
    await census2.idle();
    assert.equal(job.status, 'done');
    const summary = JSON.parse(job.report!) as Record<string, unknown>;
    assert.equal(summary.coveredAfter, T0 - 4 * DAY);
    assert.equal(summary.coveredBefore, T0 + 2 * DAY);
    assert.equal(summary.messagesScanned, 12);
    // The restart walked the two new days as one slice [T0-4d, T0-2d),
    // exactly as run 1 walked its two days as one slice.
    const queries = fake.calls.filter((c) => c.tool === 'search_gmail_messages').map((c) => String(c.args.query)).slice(searchesBefore);
    assert.deepEqual(queries, [
      `after:${T0 - 4 * DAY} before:${T0 - 2 * DAY} -in:sent -in:drafts -in:chats`,
      `after:${T0 - 4 * DAY} before:${T0 - 2 * DAY} -in:sent -in:drafts -in:chats`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
