import { z } from 'zod';
import { MEMORY_SCOPES, type MemoryConfig, type MemoryScope } from './config.js';
import { requestJson } from './http.js';
import { log, errText } from './log.js';

// Hindsight over plain HTTP. Recall runs as a host step before the model is
// called, so remembering costs no model round. Callers speak in scopes
// ("user", "self"); which bank a scope lives in is configuration.
//
// The library is a third bank with a different job: reference material Gwen
// was asked to study, filed under a topic. It is never part of the recall that
// runs before a turn, so however much it holds, it cannot crowd out what
// memory knows about the owner.

export interface Memory {
  text: string;
  scope: MemoryScope;
  /** Date the fact was mentioned, YYYY-MM-DD. */
  when?: string;
}

export interface RecallOptions {
  budget: 'low' | 'mid' | 'high';
  maxTokens: number;
  timeoutMs: number;
}

export interface Prefetch {
  memories: Memory[];
  ms: number;
  error?: string;
}

const RecallResponse = z.object({
  results: z
    .array(z.object({ text: z.string().default(''), mentioned_at: z.string().nullish() }))
    .default([]),
});

const TagsResponse = z.object({
  items: z.array(z.object({ tag: z.string(), count: z.number() })).default([]),
});

const LibraryResponse = z.object({
  results: z
    .array(
      z.object({
        text: z.string().default(''),
        context: z.string().nullish(),
        mentioned_at: z.string().nullish(),
        tags: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

export interface LibraryEntry {
  text: string;
  topics: string[];
  /** Where the material came from, as given when it was filed. */
  source?: string;
  /** Date it was filed, YYYY-MM-DD. */
  filed?: string;
}

const RETAIN_TIMEOUT_MS = 10_000;
const TAGS_TIMEOUT_MS = 10_000;

/** A topic name as the tag it is filed under: "ADHD & Autism" and "adhd-autism" are one topic. */
export function topicTag(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class Hindsight {
  constructor(private cfg: MemoryConfig) {}

  get enabled(): boolean {
    return this.cfg.key !== '';
  }

  async recall(scope: MemoryScope, query: string, opts: RecallOptions): Promise<Memory[]> {
    if (!this.enabled) return [];
    const { results } = await this.request(this.cfg.banks[scope], '/memories/recall', opts.timeoutMs, RecallResponse, {
      query,
      budget: opts.budget,
      max_tokens: opts.maxTokens,
    });
    return results.map((r) => ({ text: r.text, scope, when: r.mentioned_at?.slice(0, 10) }));
  }

  /**
   * The recall that runs before every turn: every scope at once, on a tight
   * budget. Never throws; Gwen answers without memory before she fails to answer.
   */
  async prefetch(query: string): Promise<Prefetch> {
    if (!this.enabled) return { memories: [], ms: 0 };
    const started = Date.now();
    const opts: RecallOptions = {
      budget: 'low',
      maxTokens: this.cfg.prefetchMaxTokens,
      timeoutMs: this.cfg.prefetchTimeoutMs,
    };
    const settled = await Promise.allSettled(MEMORY_SCOPES.map((scope) => this.recall(scope, query, opts)));

    const memories: Memory[] = [];
    const errors: string[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') memories.push(...outcome.value);
      else errors.push(`${MEMORY_SCOPES[i]}: ${errText(outcome.reason)}`);
    });
    if (errors.length) log.warn('memory prefetch partial failure', { errors });
    return { memories, ms: Date.now() - started, error: errors.join('; ') || undefined };
  }

  /** Save one fact. Returns the bank it went to. */
  async retain(scope: MemoryScope, content: string, context: string): Promise<string> {
    if (!this.enabled) throw new Error('memory is not configured');
    await this.request(this.cfg.banks[scope], '/memories', RETAIN_TIMEOUT_MS, z.unknown(), {
      items: [{ content, context, timestamp: new Date().toISOString(), tags: ['gwen'] }],
      async: true,
    });
    return this.cfg.banks[scope];
  }

  /**
   * File material in the library under a topic. `source` says where it came
   * from and is returned with every fact drawn from it. Returns the topic tag.
   */
  async fileInLibrary(topic: string, content: string, source: string, documentId?: string): Promise<string> {
    if (!this.enabled) throw new Error('memory is not configured');
    const tag = topicTag(topic);
    if (!tag) throw new Error(`topic ${JSON.stringify(topic)} has no letters or digits`);
    await this.request(this.cfg.libraryBank, '/memories', RETAIN_TIMEOUT_MS, z.unknown(), {
      items: [
        {
          content,
          context: source,
          timestamp: new Date().toISOString(),
          tags: [tag],
          ...(documentId ? { document_id: documentId } : {}),
        },
      ],
      async: true,
    });
    return tag;
  }

  /** Search the library, in one topic or across all of it. */
  async searchLibrary(query: string, topic: string | undefined, opts: RecallOptions): Promise<LibraryEntry[]> {
    if (!this.enabled) return [];
    const tag = topic ? topicTag(topic) : '';
    const { results } = await this.request(this.cfg.libraryBank, '/memories/recall', opts.timeoutMs, LibraryResponse, {
      query,
      budget: opts.budget,
      max_tokens: opts.maxTokens,
      // any_strict: only material filed under this topic, nothing untagged.
      ...(tag ? { tags: [tag], tags_match: 'any_strict' } : {}),
    });
    return results.map((r) => ({
      text: r.text,
      topics: r.tags ?? [],
      source: r.context ?? undefined,
      filed: r.mentioned_at?.slice(0, 10),
    }));
  }

  /** Every topic in the library and how many facts it holds. */
  async libraryTopics(): Promise<{ topic: string; facts: number }[]> {
    if (!this.enabled) return [];
    const { items } = await this.request(this.cfg.libraryBank, '/tags?limit=200', TAGS_TIMEOUT_MS, TagsResponse);
    return items.map((item) => ({ topic: item.tag, facts: item.count }));
  }

  /** POST when there is a body, GET when there is none. */
  private request<T>(bank: string, path: string, timeoutMs: number, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    return requestJson({
      service: 'hindsight',
      url: `${this.cfg.url}/v1/default/banks/${encodeURIComponent(bank)}${path}`,
      bearer: this.cfg.key,
      ...(body === undefined ? {} : { body }),
      timeoutMs,
      schema,
    });
  }
}
