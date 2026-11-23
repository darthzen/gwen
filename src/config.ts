import { readFileSync } from 'node:fs';

// All configuration comes from the environment and is read once, here. Every
// setting has its name, default and validation on one line of loadConfig.

/** Reasoning efforts OpenRouter accepts. */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Whose memory a fact belongs to: the owner's, or Gwen's own working notes. */
export const MEMORY_SCOPES = ['user', 'self'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface ModelConfig {
  /** A model slug, or `@preset/<name>` to take routing rules from the OpenRouter dashboard. */
  model: string;
  effort: Effort;
  /** Upper bound on model rounds in one run. */
  maxSteps: number;
}

export interface ResearchConfig extends ModelConfig {
  timeoutMs: number;
  maxCostUsd: number;
}

export interface JevConfig {
  model: string;
  timeoutMs: number;
}

export interface MemoryConfig {
  url: string;
  /** Empty disables memory. */
  key: string;
  /** The Hindsight bank behind each scope. The only place scope maps to a bank. */
  banks: Record<MemoryScope, string>;
  /** Budget for the recall that runs before every turn. */
  prefetchTimeoutMs: number;
  prefetchMaxTokens: number;
}

export interface WebConfig {
  searxngUrl: string;
  firecrawlUrl: string;
}

export interface BuzzConfig {
  relayUrl: string;
  privateKey: string;
  ownerPubkey: string;
}

export interface Config {
  openrouterKey: string;
  front: ModelConfig;
  research: ResearchConfig;
  jev: JevConfig;
  memory: MemoryConfig;
  web: WebConfig;
  dataDir: string;
  persona: string;
  ownerName: string;
  adapters: string[];
  /** Present only when the buzz adapter is enabled. */
  buzz: BuzzConfig | null;
}

function text(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${name}`);
}

function number(name: string, fallback: number): number {
  const raw = text(name, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = text(name, fallback);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
}

function list(name: string, fallback: string): string[] {
  return text(name, fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const adapters = list('GWEN_ADAPTERS', 'cli');
  return {
    openrouterKey: text('OPENROUTER_API_KEY'),
    front: {
      model: text('GWEN_FRONT_MODEL', '@preset/gwen-front'),
      effort: oneOf('GWEN_FRONT_EFFORT', EFFORTS, 'none'),
      maxSteps: number('GWEN_FRONT_MAX_STEPS', 8),
    },
    research: {
      model: text('GWEN_RESEARCH_MODEL', 'google/gemini-4-hydrogen'),
      effort: oneOf('GWEN_RESEARCH_EFFORT', EFFORTS, 'low'),
      maxSteps: number('GWEN_RESEARCH_MAX_STEPS', 24),
      timeoutMs: number('GWEN_RESEARCH_TIMEOUT_MS', 10 * 60_000),
      maxCostUsd: number('GWEN_RESEARCH_MAX_COST_USD', 0.75),
    },
    jev: {
      model: text('GWEN_JEV_MODEL', 'typesafe/jev-1.14'),
      timeoutMs: number('GWEN_JEV_TIMEOUT_MS', 2500),
    },
    memory: {
      url: text('HINDSIGHT_URL', 'https://api.hindsight.vectorize.io'),
      key: text('HINDSIGHT_API_KEY', ''),
      banks: {
        user: text('GWEN_USER_BANK', 'default'),
        self: text('GWEN_SELF_BANK', 'gwen'),
      },
      prefetchTimeoutMs: number('GWEN_RECALL_TIMEOUT_MS', 2500),
      prefetchMaxTokens: number('GWEN_RECALL_MAX_TOKENS', 800),
    },
    web: {
      searxngUrl: text('SEARXNG_URL', 'http://searxng.searxng.svc.cluster.local:8080'),
      firecrawlUrl: text('FIRECRAWL_URL', 'http://api.firecrawl.svc.cluster.local:3002'),
    },
    dataDir: text('GWEN_DATA_DIR', './data'),
    // No default: the persona lives outside this repo. See persona/README.txt.
    persona: readFileSync(text('GWEN_PERSONA_FILE'), 'utf8').trim(),
    ownerName: text('GWEN_OWNER_NAME', 'Rick'),
    adapters,
    buzz: adapters.includes('buzz')
      ? {
          relayUrl: text('BUZZ_RELAY_URL'),
          privateKey: text('BUZZ_PRIVATE_KEY'),
          ownerPubkey: text('BUZZ_OWNER_PUBKEY').toLowerCase(),
        }
      : null,
  };
}
