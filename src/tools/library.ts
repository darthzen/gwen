import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { Hindsight, RecallOptions } from '../memory.js';

// The library: reference material Gwen was asked to study, filed by topic.
// Unlike memory it is never searched before a turn; these tools are the only
// way in. Research reports reach it through start_research's libraryTopic.

/** Reference lookups are deliberate, so they get more time and text than the per-turn recall. */
const LIBRARY_RECALL: RecallOptions = { budget: 'mid', maxTokens: 3000, timeoutMs: 20_000 };

const topic = z.string().min(2).describe('Short topic name, e.g. "adhd" or "the-body-keeps-the-score". Reuse an existing topic when one fits.');

export function libraryTools(memory: Hindsight) {
  const libraryTopics = tool({
    name: 'library_topics',
    description: 'List the topics in your library and how many facts each holds. Check this before filing under a new topic or saying the library has nothing on a subject.',
    inputSchema: z.object({}),
    execute: async () => ({ topics: await memory.libraryTopics() }),
  });

  const librarySearch = tool({
    name: 'library_search',
    description:
      'Search your library of studied reference material. Give a topic to search only that topic, or leave it out to search everything. Each result carries the source it was filed with.',
    inputSchema: z.object({ query: z.string().min(3), topic: topic.optional() }),
    execute: async ({ query, topic }) => {
      const entries = await memory.searchLibrary(query, topic, LIBRARY_RECALL);
      return { count: entries.length, entries };
    },
  });

  const libraryFile = tool({
    name: 'library_file',
    description:
      'File one piece of reference material in your library: a passage, a page you fetched, notes on a source. General knowledge about a subject goes here; facts about the owner go to remember instead. For research with several sources, use start_research with libraryTopic and let the report be filed for you.',
    inputSchema: z.object({
      topic,
      content: z.string().min(40).describe('The material itself, in full sentences that stand on their own.'),
      source: z.string().min(4).describe('Where it came from: URL, or title and author, plus the kind of source.'),
    }),
    execute: async ({ topic, content, source }) => ({ filed: true, topic: await memory.fileInLibrary(topic, content, source) }),
  });

  return [libraryTopics, librarySearch, libraryFile] as const;
}
