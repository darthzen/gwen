import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, errText } from './log.js';

// Everything said to Gwen and everything she sent back, on every platform, in
// one log that is never trimmed. The conversation state in store.ts is what
// the model sees and is cut to the last MAX_ITEMS; this is the record that
// search_history reads.
//
// One JSON object per line, one file per UTC month, on her own volume. It
// stays readable with `cat` and `grep`, and nothing in it leaves the cluster.
// Search is a scan: a year of one person's chat is a few megabytes.

export interface Entry {
  /** When it was received or sent, ISO 8601 in UTC. */
  t: string;
  /** The platform: the adapter's name. */
  adapter: string;
  conversation: string;
  speaker: string;
  text: string;
}

export interface Range {
  /** Only entries at or after this instant. */
  from?: Date;
  /** Only entries before this instant. */
  to?: Date;
  /** Only entries from this adapter. */
  adapter?: string;
}

export interface Line extends Entry {
  /** True for a line that matched the query, false for one shown as context. */
  match: boolean;
}

export interface SearchResult {
  /** How many lines matched, including those not returned. */
  total: number;
  /** Newest first. Each is a run of consecutive lines from one conversation. */
  passages: Line[][];
}

export interface BrowseResult {
  total: number;
  /** Oldest first. */
  lines: Entry[];
}

const FILE = /^\d{4}-\d{2}\.jsonl$/;

export class Transcript {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'transcript');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Never throws: a full disk must not stop Gwen answering. */
  append(entry: Entry): void {
    try {
      appendFileSync(this.file(entry.t), `${JSON.stringify(entry)}\n`);
    } catch (e) {
      log.error('transcript append failed', { conversationId: entry.conversation, error: errText(e) });
    }
  }

  /**
   * Lines containing every word of `query`, newest first, each with `context`
   * lines of the same conversation on either side. Matching ignores case and
   * word order. Matches that fall inside one another's context share a passage.
   */
  search(query: string, range: Range, limit: number, context: number): SearchResult {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.read(range);
    const byConversation = new Map<string, Entry[]>();
    for (const e of all) {
      const list = byConversation.get(e.conversation);
      if (list) list.push(e);
      else byConversation.set(e.conversation, [e]);
    }
    const matched = new Set<Entry>();
    for (const e of all) {
      if (!inRange(e, range)) continue;
      const text = e.text.toLowerCase();
      if (words.every((w) => text.includes(w))) matched.add(e);
    }

    const shown = new Set<Entry>();
    const passages: Line[][] = [];
    for (const hit of [...matched].sort((a, b) => b.t.localeCompare(a.t))) {
      if (passages.length >= limit) break;
      if (shown.has(hit)) continue;
      const list = byConversation.get(hit.conversation)!;
      const at = list.indexOf(hit);
      const passage = list.slice(Math.max(0, at - context), at + context + 1).filter((e) => !shown.has(e));
      for (const e of passage) shown.add(e);
      passages.push(passage.map((e) => ({ ...e, match: matched.has(e) })));
    }
    return { total: matched.size, passages };
  }

  /** Every line in the range, oldest first, up to `limit`. */
  browse(range: Range, limit: number): BrowseResult {
    const lines = this.read(range).filter((e) => inRange(e, range));
    return { total: lines.length, lines: lines.slice(0, limit) };
  }

  /**
   * One-time import of what the conversation state still holds, for a volume
   * that predates the transcript. Does nothing once the transcript has a file.
   * Returns how many lines it wrote.
   */
  backfill(states: unknown[]): number {
    if (this.files().length) return 0;
    const entries = states.flatMap(entriesFromState).sort((a, b) => a.t.localeCompare(b.t));
    const months = new Map<string, string[]>();
    for (const e of entries) {
      const path = this.file(e.t);
      months.set(path, [...(months.get(path) ?? []), JSON.stringify(e)]);
    }
    for (const [path, lines] of months) writeFileSync(path, `${lines.join('\n')}\n`);
    return entries.length;
  }

  private file(t: string): string {
    return join(this.dir, `${t.slice(0, 7)}.jsonl`);
  }

  private files(): string[] {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => FILE.test(f)).sort() : [];
  }

  /**
   * Entries of every month the range touches, oldest first. Whole months, so
   * a match at the edge of the range still gets its context; callers apply
   * inRange to decide what counts.
   */
  private read(range: Range): Entry[] {
    const first = range.from?.toISOString().slice(0, 7) ?? '';
    const last = range.to?.toISOString().slice(0, 7) ?? '9999-99';
    const entries: Entry[] = [];
    for (const f of this.files()) {
      const month = f.slice(0, 7);
      if (month < first || month > last) continue;
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as Entry;
          if (!range.adapter || e.adapter === range.adapter) entries.push(e);
        } catch {
          // A crash mid-append leaves at most one cut line. Skip it.
        }
      }
    }
    return entries.sort((a, b) => a.t.localeCompare(b.t));
  }
}

function inRange(e: Entry, range: Range): boolean {
  if (range.from && e.t < range.from.toISOString()) return false;
  if (range.to && e.t >= range.to.toISOString()) return false;
  return true;
}

// ---- backfill ---------------------------------------------------------------

/** A message as frameMessage wrote it: the time, then "Speaker: text" after the context block. */
const FRAMED = /^<context machine-generated="true">\nnow: (\S+) \(UTC\)\n[\s\S]*?\n<\/context>\n\n([^:\n]+): ([\s\S]*)$/;

interface StoredItem {
  role?: string;
  type?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

/**
 * The lines one stored conversation state can still account for. A person's
 * message carries its own time. A reply has none, so it takes the time of the
 * message before it plus a millisecond: right order, time early by however
 * long the turn took. Only the last assistant text of a turn was ever sent,
 * so only that is kept; machine-generated inputs (research results) are not
 * lines of conversation and are skipped, though the reply to one is kept.
 */
export function entriesFromState(state: unknown): Entry[] {
  const s = state as { id?: string; createdAt?: number; messages?: StoredItem[] };
  if (typeof s?.id !== 'string' || !Array.isArray(s.messages)) return [];
  const conversation = s.id;
  const adapter = conversation.split(':')[0] ?? '';
  const entries: Entry[] = [];
  let clock = typeof s.createdAt === 'number' ? s.createdAt : 0;
  let reply = '';
  const add = (ms: number, speaker: string, text: string): void => {
    clock = Math.max(clock + 1, ms);
    entries.push({ t: new Date(clock).toISOString(), adapter, conversation, speaker, text });
  };
  const flush = (): void => {
    if (reply) add(0, 'Gwen', reply);
    reply = '';
  };

  for (const item of s.messages) {
    if (item.role === 'user') {
      flush();
      const framed = typeof item.content === 'string' ? FRAMED.exec(item.content) : null;
      const at = framed ? Date.parse(framed[1]!) : NaN;
      if (framed && Number.isFinite(at)) add(at, framed[2]!, framed[3]!);
    } else if (item.role === 'assistant' && Array.isArray(item.content)) {
      const text = item.content.map((part) => (part.type === 'output_text' ? (part.text ?? '') : '')).join('').trim();
      if (text) reply = text;
    }
  }
  flush();
  return entries;
}

// ---- dates in the owner's time zone ----------------------------------------

function wallClock(at: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(at);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** The instant a calendar day (YYYY-MM-DD) begins in `timeZone`, moved by `addDays`. */
export function dayStart(day: string, timeZone: string, addDays = 0): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`) + addDays * 86_400_000;
  const offsetAt = (at: number): number => {
    const w = wallClock(new Date(at), timeZone);
    return Date.UTC(+w.year!, +w.month! - 1, +w.day!, +w.hour!, +w.minute!, +w.second!) - at;
  };
  // The offset at the answer can differ from the offset at the first guess on
  // the two days a year the clocks change, so take it twice.
  const guess = midnightUtc - offsetAt(midnightUtc);
  return new Date(midnightUtc - offsetAt(guess));
}

/** `2026-11-22 20:51 CST`: a stored UTC time as the owner's clock showed it. */
export function localTime(t: string, timeZone: string): string {
  const w = wallClock(new Date(t), timeZone);
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute} ${w.timeZoneName}`;
}
