import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { ReplyTarget } from '../adapters/types.js';
import { censusReport, loadState, statePath, summaryOf, type MailCensus } from '../mailcensus.js';

// Mail census tools for the front model: start the background walk of Rick's
// Gmail mailing lists, and read its status. The walk itself runs in host code
// (src/mailcensus.ts); the model only ever sees the summary.

const DAY = 86_400;
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .optional();

export function mailCensusTools(census: MailCensus, target: ReplyTarget) {
  const startMailCensus = tool({
    name: 'start_mail_census',
    description:
      'Start the background mailing-list census of Rick\'s Gmail: it walks the mailbox by date window in host code, no message data through the model, and writes one row per list sender to a Google Sheet whose first column "Keep" Rick marks. Returns at once with a job id; the finished summary (sheet URL, window, counts) arrives later as its own message.',
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(730)
        .default(30)
        .describe('Window length in days, ending now. Default 30.'),
      since: isoDay.describe('Start of the window, YYYY-MM-DD. Overrides days.'),
      until: isoDay.describe('End of the window, YYYY-MM-DD, exclusive. Default now.'),
    }),
    execute: async ({ days, since, until }) => {
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = until ? Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000) : now;
      const windowStart = since
        ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000)
        : windowEnd - days * DAY;
      const job = census.start(target, windowStart, windowEnd);
      return { jobId: job.id, windowStart, windowEnd };
    },
  });

  const mailCensusStatus = tool({
    name: 'mail_census_status',
    description:
      'The state of the mailing-list census: the running or last job of this conversation, and what the committed state file holds so far.',
    inputSchema: z.object({}),
    execute: async () => {
      const jobs = census.jobsFor(target.conversationId).slice(-3);
      const state = loadState(census.stateDir);
      return {
        jobs: jobs.map((j) => ({
          jobId: j.id,
          status: j.status,
          started: j.createdAt,
          finished: j.finishedAt ?? null,
          delivered: j.delivered,
          ...(j.status === 'done' && j.report ? { report: censusReport(j) } : {}),
          ...(j.status === 'failed' && j.error ? { error: j.error } : {}),
        })),
        state: state
          ? {
              stateFile: statePath(census.stateDir),
              ...summaryOf(state),
              coveredThrough: state.coveredThrough,
            }
          : null,
      };
    },
  });

  return [startMailCensus, mailCensusStatus] as const;
}
