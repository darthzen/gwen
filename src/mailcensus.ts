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
// search_gmail_messages by id, then headers in batches of 100 via
// get_gmail_messages_content_batch with format=metadata. A message is
// mailing-list mail iff its headers carry List-Unsubscribe. The result is a
// Google Sheet, first column "Keep" for Rick to mark, one row per sender.
//
// Nothing here is model data: the whole walk is deterministic, state lives in
// one file under the data dir, and every slice of work is committed as it
// completes, so a restart continues where it stopped and a rerun over the
// same window never double counts.

const SEARCH_PAGE = 500;
const METADATA_BATCH = 100;
/** The header line the batch tool prints for each message in a page. */
const ID_LINE = /^Message ID: (.+)$/m;
/**
 * A page announces its next page this way. The token may be printed with or
 * without quotes; the live format has not been measured, so both are accepted.
 */
const PAGE_TOKEN = /page_token=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_\-]+))/;
const URL_LINE = /^URL: (.+)$/m;
const SEARCH_ERROR = /search failed/i;

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
  /** The first mailto link in the List-Unsubscribe header, or null. */
  listUnsubscribe: string | null;
  listId: string | null;
  /** The per-message URL the search or batch result printed, when it did. */
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
  /** The unsubscribe link, first non-null seen; null when never seen. */
  listUnsubscribe: string | null;
  listId: string | null;
}

export interface CensusState {
  /** The window in epoch seconds; the search query is built from it. */
  windowStart: number;
  windowEnd: number;
  /** Newest message date (epoch ms) committed so far; the resume point. */
  coveredThrough: number;
  /** Every message id committed so far; a rerun skips all of them. */
  processedIds: string[];
  /** Keyed by lower-cased address. */
  senders: Record<string, Sender>;
  /** Message id to its date (epoch ms), for messages that are not list mail. */
  dateById: Record<string, number>;
  /** Batch messages with no usable From line, and the batch error that hid them. */
  unreadable: { id: string; reason: string }[];
  sheetId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CensusSummary {
  windowStart: number;
  windowEnd: number;
  messagesScanned: number;
  listMessages: number;
  senderCount: number;
  unreadableCount: number;
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

/** The Gmail search query for a window, in epoch seconds. */
export function censusQuery(windowStart: number, windowEnd: number): string {
  return `after:${windowStart} before:${windowEnd} -label:inbox`;
}

/** One search result page: the message ids and the next-page token, if any. */
export function parseSearchPage(text: string): { ids: string[]; pageToken: string | null } {
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(ID_LINE);
    if (m && m[1] !== undefined) ids.push(m[1]);
  }
  const t = text.match(PAGE_TOKEN);
  const token = t ? (t[1] ?? t[2] ?? t[3]) : undefined;
  return { ids, pageToken: token ?? null };
}

/** One metadata batch: the header block printed for each message. */
export function parseMetadataBlocks(text: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^Message ID: (.+)$/);
    if (!m) continue;
    const id = m[1] !== undefined ? m[1].trim() : "";
    let subject = '';
    let fromRaw = '';
    let dateRaw = '';
    let listUnsubscribe: string | null = null;
    let listId: string | null = null;
    let url: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^Message ID: /.test(l)) break;
      const s = l.trim();
      if (s.startsWith('Subject:')) subject = s.slice('Subject:'.length).trim();
      else if (s.startsWith('From:')) fromRaw = s.slice('From:'.length).trim();
      else if (s.startsWith('Date:')) dateRaw = s.slice('Date:'.length).trim();
      else if (s.startsWith('List-Unsubscribe:') && !listUnsubscribe)
        listUnsubscribe = firstMailto(s.slice('List-Unsubscribe:'.length).trim());
      else if (s.startsWith('List-Id:') && !listId) listId = s.slice('List-Id:'.length).trim();
      else if (s.startsWith('URL:') && !url) url = s.slice('URL:'.length).trim();
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

/** The first mailto link in a List-Unsubscribe header value, or null. */
export function firstMailto(value: string): string | null {
  const m = value.match(/<mailto:([^>]+)>/);
  if (m && m[1] !== undefined) return `mailto:${m[1]}`;
  const bare = value.match(/mailto:([^\s>]+)/);
  if (bare && bare[1] !== undefined) return `mailto:${bare[1]}`;
  const plain = value.match(/<([^>\s][^>]*)>/);
  if (plain && plain[1] !== undefined) return plain[1].trim();
  return value.trim() || null;
}

/** The Gmail URL for a message id, without needing the search result. */
export function messageUrl(id: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`;
}

export function newCensusState(windowStart: number, windowEnd: number): CensusState {
  return {
    windowStart,
    windowEnd,
    coveredThrough: 0,
    processedIds: [],
    senders: {},
    dateById: {},
    unreadable: [],
    sheetId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

/**
 * Fold one batch of parsed messages into the state. Returns the ids newly
 * added. A rerun over the same window feeds the same ids back and adds
 * nothing, so nothing is double counted.
 */
export function aggregate(state: CensusState, messages: ParsedMessage[]): string[] {
  const fresh: string[] = [];
  for (const msg of messages) {
    if (state.processedIds.includes(msg.id)) continue;
    state.processedIds.push(msg.id);
    fresh.push(msg.id);
    if (msg.date > 0) state.dateById[msg.id] = msg.date;
    if (msg.listUnsubscribe) {
      const address = msg.from.address.toLowerCase();
      if (!address) {
        state.unreadable.push({ id: msg.id, reason: 'List-Unsubscribe with no From address' });
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
  }
  return fresh;
}

export function listMessageCount(state: CensusState): number {
  return Object.values(state.senders).reduce((n, s) => n + s.count, 0);
}

export function summaryOf(state: CensusState): CensusSummary {
  return {
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    messagesScanned: state.processedIds.length,
    listMessages: listMessageCount(state),
    senderCount: Object.keys(state.senders).length,
    unreadableCount: state.unreadable.length,
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
  'List-Id',
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
 * address (column C, lower-cased) to the Keep value in column A. The line
 * may begin with the row number: `1\tKeep\tName\t...` — the header row is
 * skipped either way, so only the data rows matter.
 */
export function parseKeepValues(text: string): Map<string, string> {
  const keep = new Map<string, string>();
  for (const line of text.split('\n')) {
    const cells = line.split('\t');
    if (cells.length < 3) continue;
    const [first, second, third] = [cells[0] ?? '', cells[1] ?? '', cells[2] ?? ''];
    // With a leading row number: first = number, second = Keep, third = Name.
    // Without: first = Keep, second = Name, third = Address.
    const hasRowNumber = /^\d+$/.test(first.trim());
    const keepCell = hasRowNumber ? second : first;
    const nameCell = hasRowNumber ? third : second;
    // The address is the cell that looks like an e-mail address.
    const addressCells = hasRowNumber ? cells.slice(3) : cells.slice(2);
    const address =
      addressCells.find((c) => /^[^\s@]+@[^\s@]+$/.test(c.trim()))?.trim().toLowerCase() ?? '';
    if (!address) continue;
    // Skip the header row.
    if (nameCell.trim().toLowerCase() === 'name' || address === SHEET_HEADER[2]) continue;
    keep.set(address, keepCell.trim());
  }
  return keep;
}

/** The cell range that covers the rows, for modify_sheet_values. */
export function rangeFor(rows: number, cols: number): string {
  return `A1:${String.fromCharCode(64 + cols)}${rows}`;
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
  return [
    'status: finished',
    `window: ${new Date(summary.windowStart * 1000).toISOString().slice(0, 10)} to ${new Date(summary.windowEnd * 1000).toISOString().slice(0, 10)}`,
    `messages scanned: ${summary.messagesScanned}`,
    `mailing-list messages: ${summary.listMessages}`,
    `senders: ${summary.senderCount}`,
    `unreadable: ${summary.unreadableCount}`,
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
      const state = this.continueOrStart(windowStart, windowEnd);
      this.ensureSheet(state);
      await this.walk(state, job.id);
      await this.writeSheet(state);
      state.finishedAt = new Date().toISOString();
      saveState(this.stateDir, state);
      const summary = summaryOf(state);
      job.usage = { rounds: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      this.settle(job, { report: JSON.stringify(summary) });
    } catch (e) {
      this.settle(job, { error: errText(e) });
    }
    log.info('mail census run', { jobId: job.id, ms: Date.now() - started });
  }

  private continueOrStart(windowStart: number, windowEnd: number): CensusState {
    const existing = loadState(this.stateDir);
    if (existing && existing.windowStart === windowStart && existing.windowEnd === windowEnd && !existing.finishedAt) {
      log.info('mail census resuming', { coveredThrough: existing.coveredThrough, processed: existing.processedIds.length });
      return existing;
    }
    const state = newCensusState(windowStart, windowEnd);
    saveState(this.stateDir, state);
    return state;
  }

  private async ensureSheet(state: CensusState): Promise<void> {
    if (state.sheetId) return;
    const result = await this.mcpCall('create_spreadsheet', {
      user_google_email: this.cfg.email,
      name: this.cfg.sheetName,
    });
    const text = asText(result);
    const id = text.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!id) throw new Error(`create_spreadsheet did not return a spreadsheet id: ${text.slice(0, 200)}`);
    state.sheetId = id;
    saveState(this.stateDir, state);
  }

  /** Walk the window newest-first, committing after every search page. */
  private async walk(state: CensusState, jobId: string): Promise<void> {
    log.info('mail census walking', { jobId, windowStart: state.windowStart, windowEnd: state.windowEnd });
    let pageToken: string | undefined;
    for (;;) {
      const args: Record<string, unknown> = {
        user_google_email: this.cfg.email,
        query: censusQuery(state.windowStart, state.windowEnd),
        page_size: SEARCH_PAGE,
      };
      if (pageToken) args.page_token = pageToken;
      const text = asText(await this.mcpCall('search_gmail_messages', args));
      if (SEARCH_ERROR.test(text) && !ID_LINE.test(text)) {
        throw new Error(`Gmail search failed: ${text.slice(0, 200)}`);
      }
      const { ids, pageToken: next } = parseSearchPage(text);
      const urls = this.pageUrls(text);
      if (ids.length === 0) break;
      for (let i = 0; i < ids.length; i += METADATA_BATCH) {
        const batch = ids.slice(i, i + METADATA_BATCH);
        await this.metadataBatch(state, batch, urls);
      }
      const newest = this.pageDate(state, ids);
      if (newest > state.coveredThrough) {
        state.coveredThrough = newest;
        saveState(this.stateDir, state);
      }
      if (!next) break;
      pageToken = next;
    }
  }

  private pageUrls(text: string): Map<string, string> {
    const urls = new Map<string, string>();
    const lines = text.split('\n');
    let current: string | null = null;
    for (const line of lines) {
      const id = line.match(ID_LINE);
      if (id && id[1] !== undefined) current = id[1];
      const url = line.match(URL_LINE);
      if (url && url[1] !== undefined && current) urls.set(current, url[1]);
    }
    return urls;
  }

  /** The newest committed message date among the ids of one page. */
  private pageDate(state: CensusState, ids: string[]): number {
    let newest = 0;
    for (const id of ids) {
      const d = state.dateById[id] ?? 0;
      if (d > newest) newest = d;
    }
    return newest;
  }

  private async metadataBatch(state: CensusState, ids: string[], urls: Map<string, string>): Promise<void> {
    const result = await this.mcpCall('get_gmail_messages_content_batch', {
      user_google_email: this.cfg.email,
      message_ids: ids,
      format: 'metadata',
    });
    const text = asText(result);
    let messages: ParsedMessage[];
    try {
      messages = parseMetadataBlocks(text);
    } catch (e) {
      for (const id of ids) state.unreadable.push({ id, reason: `batch unparsable: ${errText(e)}` });
      saveState(this.stateDir, state);
      return;
    }
    for (const id of ids) {
      const msg = messages.find((m) => m.id === id);
      if (!msg || !msg.from.address) {
        state.unreadable.push({ id, reason: msg ? 'no From address' : 'no block in batch result' });
      }
    }
    for (const msg of messages) {
      if (!msg.url) msg.url = urls.get(msg.id) ?? null;
    }
    aggregate(state, messages);
    saveState(this.stateDir, state);
  }

  private async writeSheet(state: CensusState): Promise<void> {
    if (!state.sheetId) return;
    const read = asText(await this.mcpCall('read_sheet_values', { user_google_email: this.cfg.email, spreadsheet_id: state.sheetId }));
    const keep = parseKeepValues(read);
    const rows = sheetRows(state, keep);
    await this.mcpCall('modify_sheet_values', {
      user_google_email: this.cfg.email,
      spreadsheet_id: state.sheetId,
      range: rangeFor(rows.length, SHEET_HEADER.length),
      values: rows,
      value_input_option: 'RAW',
    });
  }
}
