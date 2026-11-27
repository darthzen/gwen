import { OpenRouter } from '@openrouter/agent';
import type { ModelConfig } from './config.js';
import { localHttpClient } from './local.js';

// Everything about how Gwen calls OpenRouter that more than one caller needs:
// the client, the data-handling policy, and how a finished run is read.

export const OPENROUTER_API = 'https://openrouter.ai/api';

// The request timeout for a model that names none. A self-hosted model
// streams at ~49 tokens/s, so the default has to fit its full output:
// 16,384 tokens is ~5.7 minutes of generation, plus headroom for the slow
// rounds that end in a long tool call. 90 s cut a reply off at ~4,400
// tokens; GWEN_MODEL_TIMEOUT_MS raises it further when needed.
const DEFAULT_TIMEOUT_MS = 420_000;

/** The request timeout for one model: its own when it names one. */
export function timeoutFor(cfg: ModelConfig): number {
  return cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

// The SDK's default keeps retrying a failing request for an hour, once a
// minute. A request that fails the same way every time then holds its
// conversation's queue for that hour and the user hears nothing. A minute is
// enough to ride out a restart or a rate limit; after it the turn fails and
// says so.
const RETRIES = {
  strategy: 'backoff',
  backoff: { initialInterval: 1000, maxInterval: 15_000, exponent: 2, maxElapsedTime: 60_000 },
  retryConnectionErrors: true,
} as const;

/**
 * The client for one model. A model with a `baseUrl` is served from that
 * address (a self-hosted llama-server); every other model goes to OpenRouter.
 */
export function createClient(apiKey: string, cfg: ModelConfig): OpenRouter {
  if (cfg.baseUrl) {
    return new OpenRouter({
      apiKey: cfg.apiKey || 'local',
      serverURL: cfg.baseUrl,
      httpClient: localHttpClient(),
      timeoutMs: timeoutFor(cfg),
      retryConfig: RETRIES,
    });
  }
  return new OpenRouter({
    apiKey,
    httpReferer: 'https://github.com/darthzen/gwen',
    appTitle: 'Gwen',
    timeoutMs: timeoutFor(cfg),
    retryConfig: RETRIES,
  });
}

/** Gwen's data-handling policy: zero-data-retention providers that do not train on prompts. */
const ZDR_POLICY = { zdr: true, dataCollection: 'deny' } as const;

type ProviderSort = 'throughput' | 'price' | 'latency';

/**
 * The model, provider routing and reasoning fields of a callModel request.
 * A preset carries its own routing rules from the dashboard, so it gets no
 * provider block; so does a self-hosted model, which has no providers to
 * route between and keeps its prompts on our own hardware. Every other model
 * gets the ZDR policy. No effort configured means no reasoning field, so a
 * preset's own reasoning setting is the one that applies.
 */
export function modelFields(cfg: ModelConfig, sort?: ProviderSort) {
  const routed = !cfg.baseUrl && !cfg.model.startsWith('@preset/');
  return {
    model: cfg.model,
    ...(cfg.effort === undefined ? {} : { reasoning: { effort: cfg.effort } }),
    ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }),
    ...(routed ? { provider: { ...ZDR_POLICY, ...(sort ? { sort } : {}) } } : {}),
  };
}

/** Stop condition: end the run after this many model rounds. */
export function maxSteps(limit: number) {
  return ({ steps }: { steps: readonly unknown[] }): boolean => steps.length >= limit;
}

export interface Usage {
  rounds: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cost?: number;
}

interface FinishedRun {
  getText(): Promise<string>;
  getUsage(): Promise<{
    modelCalls: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cost?: number | undefined;
  }>;
}

/** Wait for a run to end and return its final text and what it cost. */
export async function finish(run: FinishedRun): Promise<{ text: string; usage: Usage }> {
  const text = (await run.getText()).trim();
  const u = await run.getUsage();
  return {
    text,
    usage: {
      rounds: u.modelCalls,
      inputTokens: u.inputTokens,
      cachedTokens: u.cachedTokens,
      outputTokens: u.outputTokens,
      cost: u.cost,
    },
  };
}
