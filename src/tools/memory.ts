import { tool } from '@openrouter/agent';
import { z } from 'zod';
import { MEMORY_SCOPES } from '../config.js';
import type { Hindsight, RecallOptions } from '../memory.js';

// Memory tools for the front model. Memory relevant to each message is already
// supplied with it (see Hindsight.prefetch); these cover saving a fact and
// asking a different question than the message itself.

const scope = z.enum(MEMORY_SCOPES);

/** A deliberate recall can afford more time and more text than the per-turn prefetch. */
const DELIBERATE_RECALL: RecallOptions = { budget: 'mid', maxTokens: 2000, timeoutMs: 15_000 };

export function memoryTools(memory: Hindsight, ownerName: string, conversationId: string) {
  const remember = tool({
    name: 'remember',
    description: `Save one durable fact to long-term memory. scope "user": a fact, decision or preference of ${ownerName}'s. scope "self": a note that only concerns how you work. Save only what was actually said or verified, in one or two plain sentences.`,
    inputSchema: z.object({ content: z.string().min(8), scope }),
    execute: async ({ content, scope }) => {
      const bank = await memory.retain(scope, content, `Gwen concierge, conversation ${conversationId}`);
      return { saved: true, bank };
    },
  });

  const recallMemory = tool({
    name: 'recall_memory',
    description:
      'Search long-term memory with a specific query. Memory relevant to the current message is already supplied with it; use this for a different or narrower question.',
    inputSchema: z.object({ query: z.string().min(3), scope: scope.default('user') }),
    execute: async ({ query, scope }) => {
      const memories = await memory.recall(scope, query, DELIBERATE_RECALL);
      return { count: memories.length, memories: memories.map((m) => ({ text: m.text, when: m.when })) };
    },
  });

  return [remember, recallMemory] as const;
}
