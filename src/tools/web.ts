import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { WebConfig } from '../config.js';
import { requestJson } from '../http.js';

// Web access through the lab's own services: SearXNG for search, Firecrawl for
// turning a page into markdown. Both are plain HTTP and need no keys. The
// front model and the research worker share these two tools.

const MAX_RESULTS = 8;
const SNIPPET_CHARS = 300;
const PAGE_CHARS = 12_000;
const SEARCH_TIMEOUT_MS = 12_000;
const SCRAPE_TIMEOUT_MS = 40_000;

const SearchResponse = z.object({
  results: z
    .array(z.object({ title: z.string().default(''), url: z.string().default(''), content: z.string().nullish() }))
    .default([]),
});

const ScrapeResponse = z.object({
  data: z.object({
    markdown: z.string().default(''),
    metadata: z.object({ title: z.string().nullish() }).optional(),
  }),
});

export function webTools(cfg: WebConfig) {
  const webSearch = tool({
    name: 'web_search',
    description:
      'Search the web. Returns titles, URLs and snippets. Use fetch_page on a result when the snippet is not enough.',
    inputSchema: z.object({ query: z.string().min(2) }),
    execute: async ({ query }) => {
      const { results } = await requestJson({
        service: 'searxng',
        url: `${cfg.searxngUrl}/search?format=json&q=${encodeURIComponent(query)}`,
        timeoutMs: SEARCH_TIMEOUT_MS,
        schema: SearchResponse,
      });
      return {
        query,
        results: results.slice(0, MAX_RESULTS).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: (r.content ?? '').slice(0, SNIPPET_CHARS),
        })),
      };
    },
  });

  const fetchPage = tool({
    name: 'fetch_page',
    description: 'Fetch one web page as markdown. Long pages are truncated.',
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const { data } = await requestJson({
        service: 'firecrawl',
        url: `${cfg.firecrawlUrl}/v1/scrape`,
        body: { url, formats: ['markdown'], onlyMainContent: true },
        timeoutMs: SCRAPE_TIMEOUT_MS,
        schema: ScrapeResponse,
      });
      if (!data.markdown) throw new Error('page returned no readable content');
      return {
        url,
        title: data.metadata?.title ?? '',
        truncated: data.markdown.length > PAGE_CHARS,
        markdown: data.markdown.slice(0, PAGE_CHARS),
      };
    },
  });

  return [webSearch, fetchPage] as const;
}
