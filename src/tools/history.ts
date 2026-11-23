import { tool } from '@openrouter/agent';
import { z } from 'zod';
import { dayStart, localTime, type Entry, type Range, type Transcript } from '../transcript.js';

// Search of the full chat record, across every platform. The model's own
// history holds only the recent turns of the conversation it is in; this is
// how it reaches anything older, or anything said on another platform.

const DEFAULT_PASSAGES = 6;
const MAX_PASSAGES = 15;
/** Lines of the same conversation shown on either side of a match. */
const CONTEXT_LINES = 2;
/** Lines returned when a date range is given with no query. */
const BROWSE_LINES = 40;
const MATCH_CHARS = 1500;
const CONTEXT_CHARS = 400;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

export interface HistoryScope {
  ownerName: string;
  /** IANA zone that dates in the tool's input and output are read in. */
  timeZone: string;
  /** The adapters this instance runs, offered as the platform filter. */
  platforms: string[];
  /** Start of the current turn. Later lines are hidden, so a search never finds the question that asked for it. */
  asOf: Date;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} […${text.length - max} more characters]` : text;
}

/** Elapsed time in plain numbers, computed here because `when` is local and the model's clock is UTC. */
export function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'under a minute ago';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

export function historyTools(transcript: Transcript, scope: HistoryScope) {
  const show = (e: Entry, max: number) => ({
    when: localTime(e.t, scope.timeZone),
    ago: ago(scope.asOf.getTime() - Date.parse(e.t)),
    platform: e.adapter,
    speaker: e.speaker,
    text: clip(e.text, max),
  });

  const searchHistory = tool({
    name: 'search_history',
    description: `Search the full record of your conversations with ${scope.ownerName}, on every platform (${scope.platforms.join(', ')}), from before the current message. Your own history holds only recent turns of this one conversation; use this for anything older or said elsewhere, and before saying you do not remember a conversation. query: words that must all appear in one message, any order, any case; it is a literal word match, so use the few most distinctive words and retry with a synonym when nothing comes back. from/to: calendar days (YYYY-MM-DD, ${scope.timeZone}), inclusive; give dates with no query to read what was said in that period. Returns matching messages newest first, each with the lines around it; \"when\" is local time and \"ago\" is how long before the current message, so take elapsed time from \"ago\" and never compute it yourself. Quote and date what you find; when nothing matches, say the record has no match for those words, which is not the same as it never having been said.`,
    inputSchema: z.object({
      query: z.string().optional(),
      from: day.optional(),
      to: day.optional(),
      platform: z.string().optional().describe(`One of: ${scope.platforms.join(', ')}. Omit to search all.`),
      limit: z.number().int().min(1).max(MAX_PASSAGES).default(DEFAULT_PASSAGES),
    }),
    execute: async ({ query, from, to, platform, limit }) => {
      const words = query?.trim() ?? '';
      if (!words && !from && !to) return { error: 'Give a query, a date range, or both.' };
      if (platform && !scope.platforms.includes(platform.toLowerCase())) {
        return { error: `Unknown platform ${JSON.stringify(platform)}. Known: ${scope.platforms.join(', ')}.` };
      }
      const end = to ? dayStart(to, scope.timeZone, 1) : scope.asOf;
      const range: Range = {
        from: from ? dayStart(from, scope.timeZone) : undefined,
        to: end < scope.asOf ? end : scope.asOf,
        adapter: platform?.toLowerCase(),
      };

      if (!words) {
        const { total, lines } = transcript.browse(range, BROWSE_LINES);
        return {
          total,
          returned: lines.length,
          ...(total > lines.length ? { note: 'Oldest lines shown. Narrow the dates or add a query for the rest.' } : {}),
          lines: lines.map((e) => show(e, CONTEXT_CHARS)),
        };
      }
      const { total, passages } = transcript.search(words, range, limit, CONTEXT_LINES);
      return {
        matches: total,
        passages: passages.map((lines) =>
          lines.map((line) => ({ ...show(line, line.match ? MATCH_CHARS : CONTEXT_CHARS), match: line.match })),
        ),
      };
    },
  });

  return [searchHistory] as const;
}
