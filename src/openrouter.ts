import { OpenRouter } from '@openrouter/agent';
import type { ModelConfig } from './config.js';

// Everything about how Gwen calls OpenRouter that more than one caller needs:
// the client, the data-handling policy, and how a finished run is read.

export const OPENROUTER_API = 'https://openrouter.ai/api';

export function createClient(apiKey: string): OpenRouter {
  return new OpenRouter({
    apiKey,
    httpReferer: 'https://github.com/darthzen/gwen',
    appTitle: 'Gwen',
    timeoutMs: 90_000,
  });
}

/** Gwen's data-handling policy: zero-data-retention providers that do not train on prompts. */
const ZDR_POLICY = { zdr: true, dataCollection: 'deny' } as const;

type ProviderSort = 'throughput' | 'price' | 'latency';

/**
 * The model, provider routing and reasoning fields of a callModel request.
 * A preset carries its own routing rules from the dashboard, so it gets no
 * provider block; every other model gets the ZDR policy.
 */
export function modelFields(cfg: ModelConfig, sort?: ProviderSort) {
  const isPreset = cfg.model.startsWith('@preset/');
  return {
    model: cfg.model,
    reasoning: { effort: cfg.effort },
    ...(isPreset ? {} : { provider: { ...ZDR_POLICY, ...(sort ? { sort } : {}) } }),
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
