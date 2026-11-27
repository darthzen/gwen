import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplyTarget } from './adapters/types.js';
import type { Store, Job } from './store.js';
import { writeAtomic } from './store.js';
import type { Usage } from './openrouter.js';
import { errText, log } from './log.js';

// A census of the mailing lists in Rick's mailbox, done in host code so no
// message data passes through a model. Gmail is walked by date window:
// search_gmail_messages by id, then headers in batches of 25 via
// get_gmail_messages_content_batch with format=metadata. A message is
// mailing-list mail iff its headers carry List-Unsubscribe. The result is a
// Google Sheet, first column "Keep" for Rick to mark, one row per sender.
//
// One persistent census, not one per window. The state file holds the sheet
// id forever, the per-sender aggregates, and the covered range
// [coveredAfter, coveredBefore) in epoch seconds. A run scans only the parts
// of its window that are not yet covered, in 30-day slices committed as they
// finish, so a restart continues where it stopped. Nothing per-message is
// kept: with covered ranges a rerun is a no-op, so there is nothing to
// de-duplicate.
//
// The output format of every workspace-mcp call is pinned by real captures in
// test/fixtures-mailcensus.ts.

const DAY = 86_400;
/** Gmail caps a search page at 1000 results. */
const SEARCH_PAGE = 1000;
/** The batch tool fetches in its own groups of 25; 100 per call is 4 groups. */
const METADATA_BATCH = 100;
/** Coverage is committed in slices this wide, so a restart costs at most one. */
const SLICE = 30 * DAY;
/** read_sheet_values clamps a range to at most 1000 rows. */
export const SHEET_READ_ROWS = 1000;

// Parsers for the live output. The fixtures in test/fixtures-mailcensus.ts
// were captured from the real server on 2026-11-27; the tests parse those.
/** A message id on a search page: `  1. Message ID: 1a20...` (indented). */
const ID_LINE = /^\s*\d+\.\s*Message ID:\s*(\S+)/;
/** The per-message link on a search page and in a metadata block. */
const WEB_LINK = /^\s*Web Link:\s*(\S+)/;
/** A search page announces its next page in single quotes. */
const PAGE_TOKEN = /page_token='([^']+)'/;
/** The batch result prints "N" in its first line; the blocks are real. */
const BATCH_COUNT = /^Retrieved (\d+) message/m;
/** The sheet the census writes to, one line per row: number, then cells. */
const SHEET_ROW = /^\d+\t/;

export interface From {
  /** The display name as written in the From header, or '' for none. */
  name: string;
  address: string;
}

export interface ParsedMessage {
  id: string;
  subject: string;
  from: From;
  /** Parsed date; the epoch in milliseconds, or 0 when unparseable. */
  date: number;
  /** The unsubscribe link to offer: https first, mailto second, or null. */
  listUnsubscribe: string | null;
  listId: string | null;
  /** The Web Link the search or batch result printed, when it did. */
  url: string | null;
}

export interface Sender {
  /** Lower-cased address: the key of the senders map and the Keep match. */
  address: string;
  name: string;
  count: number;
  /** Epoch milliseconds of the first and last message seen from this sender. */
  firstSeen: number;
  lastSeen: number;
  /** One example message, for the "sample" link in the sheet. */
  example: { id: string; subject: string; url: string | null };
  /** The unsubscribe link, first usable one seen; null when never seen. */
  listUnsubscribe: string | null;
  listId: string | null;
}

export interface CensusState {
  /** The covered range in epoch seconds, contiguous: [coveredAfter, coveredBefore). */
  coveredAfter: number;
  coveredBefore: number;
  /** The sheet, created on first run and kept for the life of the census. */
  sheetId: string | null;
  /** Keyed by lower-cased address. */
  senders: Record<string, Sender>;
  /** Counters over everything scanned so far. */
  messagesScanned: number;
  listMessages: number;
  unreadableTotal: number;
  startedAt: string;
}

export interface CensusSummary {
  coveredAfter: number;
  coveredBefore: number;
  messagesScanned: number;
  listMessages: number;
  senderCount: number;
  unreadableTotal: number;
  /** Unreadable in the run that just finished; 0 when the state is idle. */
  unreadableThisRun: number;
  sheetUrl: string | null;
  sheetId: string | null;
}

export interface CensusConfig {
  /** The Google account the census runs as. */
  email: string;
  /** The MCP server that reaches Gmail and Sheets. */
  mcpServer: string;
  /** The sheet the census writes to, created on first run. */
  sheetName: string;
}

/** The Gmail search query for a slice: everything received, minus sent, drafts and chats. */
export function censusQuery(start: number, end: number): string {
  return `after:${start} before:${end} -in:sent -in:drafts -in:chats`;
}

/** One search result page: the message ids, their web links, the next-page token. */
export function parseSearchPage(text: string): {
  ids: string[];
  urls: Map<string, string>;
  pageToken: string | null;
} {
  const ids: string[] = [];
  const urls = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const id = line.match(ID_LINE);
    if (id && id[1] !== undefined) {
      current = id[1];
      ids.push(current);
      continue;
    }
    const url = line.match(WEB_LINK);
    if (url && url[1] !== undefined && current) urls.set(current, url[1]);
  }
  const t = text.match(PAGE_TOKEN);
  return { ids, urls, pageToken: t && t[1] !== undefined ? t[1] : null };
}

/** One metadata batch: the header block printed for each message. */
export function parseMetadataBlocks(text: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^Message ID: (.+)$/);
    if (!m) continue;
    const id = m[1] !== undefined ? m[1].trim() : '';
    let subject = '';
    let fromRaw = '';
    let dateRaw = '';
    let listUnsubscribe: string | null = null;
    let listId: string | null = null;
    let url: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j]!.trim();
      if (/^Message ID: /.test(s)) break;
      if (s.startsWith('Subject:')) subject = s.slice('Subject:'.length).trim();
      else if (s.startsWith('From:')) fromRaw = s.slice('From:'.length).trim();
      else if (s.startsWith('Date:')) dateRaw = s.slice('Date:'.length).trim();
      else if (s.startsWith('List-Unsubscribe:') && !listUnsubscribe)
        listUnsubscribe = unsubscribeLink(s.slice('List-Unsubscribe:'.length).trim());
      else if (s.startsWith('List-Id:') && !listId) listId = s.slice('List-Id:'.length).trim();
      else if (s.startsWith('Web Link:') && !url) url = s.slice('Web Link:'.length).trim();
    }
    out.push({
      id,
      subject,
      from: parseFrom(fromRaw),
      date: dateRaw && !Number.isNaN(Date.parse(dateRaw)) ? Date.parse(dateRaw) : 0,
      listUnsubscribe,
      listId,
      url,
    });
  }
  return out;
}

/** A From header: `Name <a@b>`, `a@b`, or bare text. */
export function parseFrom(raw: string): From {
  const m = raw.match(/^"?([^<"]*)"?\s*<([^>]+)>/);
  if (m && m[1] !== undefined && m[2] !== undefined) return { name: m[1].trim(), address: m[2].trim() };
  return { name: '', address: raw.trim() };
}

/**
 * The unsubscribe link to offer Rick: an https link if the header has one,
 * else a mailto: he clicks these. The raw header value is the fallback.
 */
export function unsubscribeLink(value: string): string | null {
  const links = [...value.matchAll(/<([^>\s][^>]*)>/g)].map((m) => (m[1] ?? '').trim());
  const https = links.find((l) => /^https:\/\//.test(l));
  if (https) return https;
  const mailto = links.find((l) => l.startsWith('mailto:'));
  if (mailto) return mailto;
  const bare = value.match(/(https:\/\/\S+|mailto:[^\s>]+)/);
  if (bare && bare[1] !== undefined) return bare[1];
  return value.trim() || null;
}

/** The Gmail URL for a message id, without needing the search result. */
export function messageUrl(id: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`;
}

export function newCensusState(): CensusState {
  return {
    coveredAfter: 0,
    coveredBefore: 0,
    sheetId: null,
    senders: {},
    messagesScanned: 0,
    listMessages: 0,
    unreadableTotal: 0,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Fold one batch of parsed messages into the state. Returns how many of the
 * messages were list mail. Called once per metadata batch, so the counters
 * never double count: a slice is committed to the covered range only after
 * its batches are folded.
 */
export function aggregate(state: CensusState, messages: ParsedMessage[]): number {
  let list = 0;
  for (const msg of messages) {
    if (msg.date > 0) state.messagesScanned += 1;
    if (!msg.listUnsubscribe) continue;
    list += 1;
    state.listMessages += 1;
    const address = msg.from.address.toLowerCase();
    if (!address) {
      state.unreadableTotal += 1;
      continue;
    }
    let sender = state.senders[address];
    if (!sender) {
      sender = {
        address,
        name: msg.from.name,
        count: 0,
        firstSeen: 0,
        lastSeen: 0,
        example: { id: msg.id, subject: msg.subject, url: msg.url },
        listUnsubscribe: null,
        listId: null,
      };
      state.senders[address] = sender;
    }
    sender.count += 1;
    if (!sender.name && msg.from.name) sender.name = msg.from.name;
    if (msg.date > 0) {
      if (sender.firstSeen === 0 || msg.date < sender.firstSeen) sender.firstSeen = msg.date;
      if (msg.date > sender.lastSeen) sender.lastSeen = msg.date;
    }
    if (!sender.listUnsubscribe && msg.listUnsubscribe) sender.listUnsubscribe = msg.listUnsubscribe;
    if (!sender.listId && msg.listId) sender.listId = msg.listId;
    if (!sender.example.url && msg.url) sender.example.url = msg.url;
  }
  return list;
}

export function summaryOf(state: CensusState, unreadableThisRun = 0): CensusSummary {
  return {
    coveredAfter: state.coveredAfter,
    coveredBefore: state.coveredBefore,
    messagesScanned: state.messagesScanned,
    listMessages: state.listMessages,
    senderCount: Object.keys(state.senders).length,
    unreadableTotal: state.unreadableTotal,
    unreadableThisRun,
    sheetUrl: state.sheetId ? `https://docs.google.com/spreadsheets/d/${state.sheetId}/edit` : null,
    sheetId: state.sheetId,
  };
}

// The sheet: column A is Keep (Rick's mark), then one column per field.
// Rows are rewritten on every run; Keep is preserved by matching address.

export const SHEET_HEADER = [
  'Keep',
  'Name',
  'Address',
  'Count',
  'First seen',
  'Last seen',
  'Unsubscribe',
  'Sample',
];

const iso = (epochMs: number): string => (epochMs > 0 ? new Date(epochMs).toISOString().slice(0, 10) : '');

/** The sheet rows for the state, Keep values matched by address. */
export function sheetRows(state: CensusState, keep: Map<string, string>): string[][] {
  const rows = [SHEET_HEADER];
  const senders = Object.values(state.senders).sort(
    (a, b) => b.count - a.count || a.address.localeCompare(b.address),
  );
  for (const s of senders) {
    rows.push([
      keep.get(s.address) ?? '',
      s.name,
      s.address,
      String(s.count),
      iso(s.firstSeen),
      iso(s.lastSeen),
      s.listUnsubscribe ?? '',
      s.example.url ?? messageUrl(s.example.id),
      s.listId ?? '',
    ]);
  }
  return rows;
}

/**
 * Parse the read_sheet_values result, `row\tcell\tcell...` per line, into
 * address (column C, lower-cased) to the Keep value in column A. The live
 * format always carries the leading row number; the header row is skipped.
 */
export function parseKeepValues(text: string): Map<string, string> {
  const keep = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!SHEET_ROW.test(line)) continue;
    const cells = line.split('\t');
    // The live format always carries the leading row number, so the cells
    // shift by one: cells[1] is column A, cells[2] column B, cells[3] column
    // C. The census sheet (SHEET_HEADER) has the address in column C, the
    // Keep mark in column A; Rick's existing sheet has no Keep column, so
    // column B (the name) is the label and column C the address.
    const a = (cells[1] ?? '').trim();
    const b = (cells[2] ?? '').trim();
    const c = (cells[3] ?? '').trim();
    const address = (c.includes('@') ? c : b).toLowerCase();
    if (!address || !/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    // Skip the header row.
    if (b.toLowerCase() === 'name' || address === (SHEET_HEADER[2] ?? '').toLowerCase()) continue;
    // The census sheet (SHEET_HEADER) has the Keep mark in column A; a sheet
    // without a Keep column carries the label in column A instead, which is
    // what Rick's existing sheet does.
    keep.set(address, a);
  }
  return keep;
}

// State file handling.

export const STATE_FILE = 'mail-census.json';

export function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

export function loadState(dataDir: string): CensusState | null {
  const path = statePath(dataDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CensusState;
}

export function saveState(dataDir: string, state: CensusState): void {
  writeAtomic(statePath(dataDir), JSON.stringify(state, null, 2));
}

// The runner.

type McpCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

function asText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as { content?: unknown; text?: unknown };
    if (typeof r.text === 'string') return r.text;
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .join('\n');
    }
  }
  return JSON.stringify(result ?? '');
}

/** The finished census, for the report the front model relays. */
export function censusReport(job: Job): string {
  const summary = job.report ? (JSON.parse(job.report) as CensusSummary) : null;
  if (!summary) return `status: failed\nerror: ${job.error}`;
  const covered =
    summary.coveredAfter > 0
      ? `${new Date(summary.coveredAfter * 1000).toISOString().slice(0, 10)} to ${new Date(summary.coveredBefore * 1000).toISOString().slice(0, 10)}`
      : 'nothing (the window was empty)';
  return [
    'status: finished',
    `covered: ${covered}`,
    `messages scanned: ${summary.messagesScanned}`,
    `mailing-list messages: ${summary.listMessages}`,
    `senders: ${summary.senderCount}`,
    `unreadable: ${summary.unreadableThisRun} in this run, ${summary.unreadableTotal} in total`,
    `sheet: ${summary.sheetUrl ?? '(none written)'}`,
  ].join('\n');
}

export class MailCensus {
  private running = new Map<string, Promise<void>>();

  constructor(
    readonly stateDir: string,
    private cfg: CensusConfig,
    private mcpCall: McpCall,
    private store: Store,
    /** Called once per job when it ends, whether it succeeded or failed. */
    private onSettled: (job: Job) => void,
  ) {}

  start(target: ReplyTarget, windowStart: number, windowEnd: number): Job {
    const job: Job = {
      ...target,
      id: `mc-${randomUUID().slice(0, 8)}`,
      question: `mail census ${windowStart}-${windowEnd}`,
      context: '',
      status: 'running',
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    this.store.saveJob(job);
    const work = this.run(job, windowStart, windowEnd).finally(() => this.running.delete(job.id));
    this.running.set(job.id, work);
    return job;
  }

  jobsFor(conversationId: string): Job[] {
    return this.store.listJobs().filter((job) => job.conversationId === conversationId && job.id.startsWith('mc-'));
  }

  markDelivered(job: Job): void {
    job.delivered = true;
    this.store.saveJob(job);
  }

  /** A census job that died with the previous process; the state file continues it. */
  recover(): Job[] {
    const jobs = this.store.listJobs();
    const census = jobs.filter((job) => job.id.startsWith('mc-'));
    for (const job of census) {
      if (job.status === 'running') this.settle(job, { error: 'Gwen restarted while the census was running; the state file continues it' });
    }
    return census.filter((job) => !job.delivered);
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Resolves when the censuses running now have settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  private settle(job: Job, outcome: { report: string } | { error: string }): void {
    job.status = 'error' in outcome ? 'failed' : 'done';
    job.finishedAt = new Date().toISOString();
    if ('report' in outcome) job.report = outcome.report;
    else job.error = outcome.error;
    this.store.saveJob(job);
    log.info('mail census settled', { jobId: job.id, status: job.status, error: job.error });
    this.onSettled(job);
  }

  private async run(job: Job, windowStart: number, windowEnd: number): Promise<void> {
    const started = Date.now();
    try {
      const state = loadState(this.stateDir) ?? newCensusState();
      await this.ensureSheet(state);
      saveState(this.stateDir, state);
      const slices = this.slicesFor(state, windowStart, windowEnd);
      let unreadableThisRun = 0;
      for (const [s, e] of slices) {
        unreadableThisRun += await this.walkSlice(state, s, e, job.id);
        saveState(this.stateDir, state);
      }
      await this.writeSheet(state);
      saveState(this.stateDir, state);
      job.usage = { rounds: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      this.settle(job, { report: JSON.stringify(summaryOf(state, unreadableThisRun)) });
    } catch (e) {
      this.settle(job, { error: errText(e) });
    }
    log.info('mail census run', { jobId: job.id, ms: Date.now() - started });
  }

  /**
   * The 30-day slices of the requested window that are not yet covered.
   * The covered range must stay contiguous: a request that would leave a
   * gap is refused, saying which start date would work.
   */
  private slicesFor(state: CensusState, windowStart: number, windowEnd: number): [number, number][] {
    if (windowEnd <= windowStart) throw new Error('census window end is not after its start');
    if (state.coveredAfter > 0 && state.coveredBefore > 0) {
      if (windowEnd < state.coveredBefore) return [];
      if (windowStart < state.coveredAfter)
        throw new Error(
          `census coverage starts ${new Date(state.coveredAfter * 1000).toISOString().slice(0, 10)}; ` +
            `ask again with a start on or after that date`,
        );
      if (windowStart > state.coveredBefore)
        throw new Error(
          `census coverage is contiguous through ${new Date(state.coveredBefore * 1000).toISOString().slice(0, 10)}; ` +
            `a start on ${new Date(state.coveredBefore * 1000).toISOString().slice(0, 10)} would keep it gap-free`,
        );
    }
    const from = state.coveredBefore > 0 ? Math.min(state.coveredBefore, windowEnd) : windowStart;
    const slices: [number, number][] = [];
    for (let s = from; s < windowEnd; s += SLICE) {
      const e = Math.min(s + SLICE, windowEnd);
      if (e > state.coveredBefore) slices.push([s, e]);
    }
    return slices;
  }

  /**
   * Walk one slice newest-first, committing the covered range when it is
   * done. Returns the unreadable count for the slice.
   */
  private async walkSlice(state: CensusState, start: number, end: number, jobId: string): Promise<number> {
    log.info('mail census walking slice', { jobId, start, end });
    let unreadable = 0;
    let pageToken: string | undefined;
    for (;;) {
      const args: Record<string, unknown> = {
        user_google_email: this.cfg.email,
        query: censusQuery(start, end),
        page_size: SEARCH_PAGE,
      };
      if (pageToken) args.page_token = pageToken;
      const text = asText(await this.mcpCall('search_gmail_messages', args));
      if (/search failed/i.test(text) && !ID_LINE.test(text)) {
        throw new Error(`Gmail search failed: ${text.slice(0, 200)}`);
      }
      const { ids, urls, pageToken: next } = parseSearchPage(text);
      if (ids.length === 0) break;
      for (let i = 0; i < ids.length; i += METADATA_BATCH) {
        unreadable += await this.metadataBatch(state, ids.slice(i, i + METADATA_BATCH), urls);
      }
      if (!next) break;
      pageToken = next;
    }
    if (end > state.coveredBefore) state.coveredBefore = end;
    if (state.coveredAfter === 0 || start < state.coveredAfter) state.coveredAfter = start;
    return unreadable;
  }

  private async metadataBatch(state: CensusState, ids: string[], urls: Map<string, string>): Promise<number> {
    const result = await this.mcpCall('get_gmail_messages_content_batch', {
      user_google_email: this.cfg.email,
      message_ids: ids,
      format: 'metadata',
    });
    const text = asText(result);
    let messages: ParsedMessage[];
    let unparsed = 0;
    try {
      messages = parseMetadataBlocks(text);
    } catch (e) {
      state.unreadableTotal += ids.length;
      log.error('mail census batch unparsable', { ids: ids.length, error: errText(e) });
      return ids.length;
    }
    const seen = new Set(messages.map((m) => m.id));
    for (const id of ids) {
      if (!seen.has(id)) {
        state.unreadableTotal += 1;
        unparsed += 1;
      }
    }
    for (const msg of messages) {
      if (!msg.url) msg.url = urls.get(msg.id) ?? null;
    }
    aggregate(state, messages);
    return unparsed;
  }

  /**
   * Rewrite the sheet from the state, keeping Rick's Keep marks. The read
   * walks the Keep and Address columns in 1000-row chunks so more than 1000
   * rows survive; a failed read starts the marks from blank and says so.
   */
  private async writeSheet(state: CensusState): Promise<void> {
    if (!state.sheetId) throw new Error('census has no sheet: create_spreadsheet did not run');
    let keep: Map<string, string>;
    try {
      keep = await this.readKeep(state.sheetId);
    } catch (e) {
      // A failed read starts the marks from blank; the run itself goes on.
      keep = new Map();
      log.warn('mail census sheet read failed, Keep marks start blank', { error: errText(e) });
    }
    const rows = sheetRows(state, keep);
    await this.mcpCall('modify_sheet_values', {
      user_google_email: this.cfg.email,
      spreadsheet_id: state.sheetId,
      // Top-left cell only: the declared range must not be wider than the
      // rows sent, or the hub rejects the write.
      range_name: 'A1',
      values: rows,
      value_input_option: 'RAW',
    });
  }

  private async readKeep(sheetId: string): Promise<Map<string, string>> {
    const keep = new Map<string, string>();
    for (let startRow = 1; ; startRow += SHEET_READ_ROWS) {
      const endRow = startRow + SHEET_READ_ROWS - 1;
      const text = asText(
        await this.mcpCall('read_sheet_values', {
          user_google_email: this.cfg.email,
          spreadsheet_id: sheetId,
          range_name: `A${startRow}:C${endRow}`,
        }),
      );
      for (const [address, value] of parseKeepValues(text)) keep.set(address, value);
      // A short or empty read means there are no more rows.
      const dataRows = text.split('\n').filter((l) => SHEET_ROW.test(l)).length;
      if (dataRows < SHEET_READ_ROWS) break;
    }
    return keep;
  }

  private async ensureSheet(state: CensusState): Promise<void> {
    if (state.sheetId) return;
    const result = await this.mcpCall('create_spreadsheet', {
      user_google_email: this.cfg.email,
      title: this.cfg.sheetName,
    });
    const text = asText(result);
    const id = text.match(/\bID:\s*([a-zA-Z0-9-_]+)/)?.[1];
    if (!id) throw new Error(`create_spreadsheet did not return a spreadsheet id: ${text.slice(0, 200)}`);
    state.sheetId = id;
  }
}
