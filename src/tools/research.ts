import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { ReplyTarget } from '../adapters/types.js';
import type { Research } from '../research.js';

// Research tools for the front model: start a background job, and list the
// jobs of the current conversation.

const STATUS_LIST_LENGTH = 10;

export function researchTools(research: Research, target: ReplyTarget) {
  const startResearch = tool({
    name: 'start_research',
    description:
      'Start background research that takes longer than a quick lookup: several sources, a comparison, a survey. Returns at once with a job id. The finished report arrives later as its own message; do not wait for it and do not guess its content.',
    inputSchema: z.object({
      question: z.string().min(8).describe('Self-contained question. The worker sees nothing else.'),
      context: z.string().default('').describe('What the worker needs from this conversation and from memory.'),
      libraryTopic: z
        .string()
        .default('')
        .describe('Set this only when the research is study material to keep: the finished report is then filed in your library under this topic. Leave empty for a one-off question.'),
    }),
    execute: async ({ question, context, libraryTopic }) => {
      const job = research.start(target, question, context, libraryTopic.trim() || undefined);
      return { jobId: job.id, status: job.status, ...(job.libraryTopic ? { libraryTopic: job.libraryTopic } : {}) };
    },
  });

  const researchStatus = tool({
    name: 'research_status',
    description: 'List background research jobs for this conversation and their status.',
    inputSchema: z.object({}),
    execute: async () => ({
      jobs: research
        .jobsFor(target.conversationId)
        .slice(-STATUS_LIST_LENGTH)
        .map((j) => ({
          jobId: j.id,
          question: j.question,
          status: j.status,
          started: j.createdAt,
          finished: j.finishedAt,
          delivered: j.delivered,
        })),
    }),
  });

  return [startResearch, researchStatus] as const;
}
