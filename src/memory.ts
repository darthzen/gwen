import { z } from 'zod';
import { MEMORY_SCOPES, type MemoryConfig, type MemoryScope } from './config.js';
import { requestJson } from './http.js';
import { log, errText } from './log.js';

// Hindsight over plain HTTP. Recall runs as a host step before the model is
// called, so remembering costs no model round. Callers speak in scopes
// ("user", "self"); which bank a scope lives in is configuration.

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

const RETAIN_TIMEOUT_MS = 10_000;

export class Hindsight {
  constructor(private cfg: MemoryConfig) {}

  get enabled(): boolean {
    return this.cfg.key !== '';
  }

  async recall(scope: MemoryScope, query: string, opts: RecallOptions): Promise<Memory[]> {
    if (!this.enabled) return [];
    const { results } = await this.post(scope, '/memories/recall', opts.timeoutMs, RecallResponse, {
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
    await this.post(scope, '/memories', RETAIN_TIMEOUT_MS, z.unknown(), {
      items: [{ content, context, timestamp: new Date().toISOString(), tags: ['gwen'] }],
      async: true,
    });
    return this.cfg.banks[scope];
  }

  private post<T>(scope: MemoryScope, path: string, timeoutMs: number, schema: z.ZodType<T>, body: unknown): Promise<T> {
    const bank = encodeURIComponent(this.cfg.banks[scope]);
    return requestJson({
      service: 'hindsight',
      url: `${this.cfg.url}/v1/default/banks/${bank}${path}`,
      bearer: this.cfg.key,
      body,
      timeoutMs,
      schema,
    });
  }
}
