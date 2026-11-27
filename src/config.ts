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
  /**
   * Reasoning effort sent with every request. Undefined sends none, which
   * leaves reasoning to the preset: a value in the request wins over the
   * preset's own, so a preset can only manage it when nothing is sent.
   */
  effort?: Effort;
  /** Upper bound on model rounds in one run. */
  maxSteps: number;
  /**
   * Upper bound on the tokens of one model round: the reply, or a tool call
   * with its arguments. Unset sends no limit. A round that hits it is cut
   * off, so it has to fit the largest file Gwen writes in one tool call.
   */
  maxOutputTokens?: number;
  /**
   * Where the model is served. Empty means OpenRouter. Set to the `/v1` address
   * of a self-hosted llama-server to run this model there instead; `model` is
   * then that server's model name.
   */
  baseUrl: string;
  /** Sent to a self-hosted server that wants a key. Unused on OpenRouter. */
  apiKey: string;
  /** Sampling temperature. Unset leaves it to the model, preset or server. */
  temperature?: number;
  /**
   * The request timeout for this model alone. Unset uses the default that
   * fits a self-hosted model's full output (see src/openrouter.ts).
   */
  timeoutMs?: number;
}

/** Automatic handoff, clear and resume of a front-model task that outgrows one run. See src/handoff.ts. */
export interface HandoffConfig {
  /** Automatic resumes in a row before Gwen stops and reports. 0 turns handoff off. */
  maxResumes: number;
  /** Hand off when one round's prompt reaches this many tokens. 0 is off. */
  inputTokens: number;
  /** Hand off when one run has added this many history items. 0 is off. */
  items: number;
}

export interface ResearchConfig extends Omit<ModelConfig, 'timeoutMs'> {
  /** The whole job's deadline: every model round and tool call inside it. */
  timeoutMs: number;
  /** The per-request timeout for the research model. Unset uses the default. */
  requestTimeoutMs?: number;
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
  /** The bank that holds reference material. Searched on request only, never before a turn. */
  libraryBank: string;
  /** Budget for the recall that runs before every turn. */
  prefetchTimeoutMs: number;
  prefetchMaxTokens: number;
}

export interface WebConfig {
  searxngUrl: string;
  firecrawlUrl: string;
}

export interface SandboxConfig {
  /** Empty disables the sandbox tool. */
  host: string;
  port: number;
  user: string;
  /** Contents of the private key file. */
  privateKey: string;
  /** Pinned host key as `SHA256:...`. Empty accepts any host key. */
  hostKey: string;
}

export interface BuzzConfig {
  relayUrl: string;
  privateKey: string;
  ownerPubkey: string;
}

export interface TelegramConfig {
  /** The bot's token from @BotFather. */
  token: string;
  /** The one person Gwen answers: a numeric user id, or a username without the @. */
  owner: string;
}

export interface Config {
  openrouterKey: string;
  front: ModelConfig;
  handoff: HandoffConfig;
  research: ResearchConfig;
  jev: JevConfig;
  memory: MemoryConfig;
  web: WebConfig;
  /** Present only when GWEN_SANDBOX_HOST is set. */
  sandbox: SandboxConfig | null;
  dataDir: string;
  /** Directory of skill files (see src/skills.ts). Empty means no skills. */
  skillsDir: string;
  persona: string;
  ownerName: string;
  /** IANA zone the owner lives in. Dates in search_history are read and shown in it. */
  timeZone: string;
  adapters: string[];
  /** Present only when the buzz adapter is enabled. */
  buzz: BuzzConfig | null;
  /** Present only when the telegram adapter is enabled. */
  telegram: TelegramConfig | null;
  /** The mailing-list census (see README, census section). */
  census: { email: string; sheetName: string };
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

function optionalNumber(name: string): number | undefined {
  return text(name, '') === '' ? undefined : number(name, 0);
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = text(name, fallback);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
}

/**
 * A model's reasoning effort. A model named as a preset sends none unless the
 * variable is set, so the preset's reasoning setting applies; any other model
 * gets the fallback.
 */
function effortFor(name: string, model: string, fallback: Effort): Effort | undefined {
  if (model.startsWith('@preset/') && !process.env[name]?.trim()) return undefined;
  return oneOf(name, EFFORTS, fallback);
}

function list(name: string, fallback: string): string[] {
  return text(name, fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

function timeZone(name: string, fallback: string): string {
  const value = text(name, fallback);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(`${name} must be an IANA time zone such as America/Chicago; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadConfig(): Config {
  const adapters = list('GWEN_ADAPTERS', 'cli');
  const sandboxHost = text('GWEN_SANDBOX_HOST', '');
  const frontModel = text('GWEN_FRONT_MODEL', '@preset/gwen-front');
  const researchModel = text('GWEN_RESEARCH_MODEL', 'google/gemini-4-hydrogen');
  return {
    openrouterKey: text('OPENROUTER_API_KEY'),
    front: {
      model: frontModel,
      effort: effortFor('GWEN_FRONT_EFFORT', frontModel, 'none'),
      maxSteps: number('GWEN_FRONT_MAX_STEPS', 8),
      maxOutputTokens: number('GWEN_FRONT_MAX_OUTPUT_TOKENS', 8192),
      baseUrl: text('GWEN_FRONT_BASE_URL', ''),
      apiKey: text('GWEN_FRONT_API_KEY', ''),
      temperature: optionalNumber('GWEN_FRONT_TEMPERATURE'),
      timeoutMs: optionalNumber('GWEN_FRONT_TIMEOUT_MS'),
    },
    handoff: {
      maxResumes: number('GWEN_MAX_RESUMES', 10),
      inputTokens: number('GWEN_HANDOFF_INPUT_TOKENS', 180_000),
      items: number('GWEN_HANDOFF_ITEMS', 80),
    },
    research: {
      model: researchModel,
      effort: effortFor('GWEN_RESEARCH_EFFORT', researchModel, 'low'),
      maxSteps: number('GWEN_RESEARCH_MAX_STEPS', 24),
      baseUrl: text('GWEN_RESEARCH_BASE_URL', ''),
      apiKey: text('GWEN_RESEARCH_API_KEY', ''),
      temperature: optionalNumber('GWEN_RESEARCH_TEMPERATURE'),
      timeoutMs: number('GWEN_RESEARCH_JOB_TIMEOUT_MS', 10 * 60_000),
      requestTimeoutMs: optionalNumber('GWEN_RESEARCH_TIMEOUT_MS'),
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
      libraryBank: text('GWEN_LIBRARY_BANK', 'library'),
      prefetchTimeoutMs: number('GWEN_RECALL_TIMEOUT_MS', 2500),
      prefetchMaxTokens: number('GWEN_RECALL_MAX_TOKENS', 800),
    },
    web: {
      searxngUrl: text('SEARXNG_URL', 'http://searxng.searxng.svc.cluster.local:8080'),
      firecrawlUrl: text('FIRECRAWL_URL', 'http://api.firecrawl.svc.cluster.local:3002'),
    },
    sandbox: sandboxHost
      ? {
          host: sandboxHost,
          port: number('GWEN_SANDBOX_PORT', 22),
          user: text('GWEN_SANDBOX_USER', 'gwen'),
          privateKey: readFileSync(text('GWEN_SANDBOX_KEY_FILE'), 'utf8'),
          hostKey: text('GWEN_SANDBOX_HOST_KEY', ''),
        }
      : null,
    dataDir: text('GWEN_DATA_DIR', './data'),
    skillsDir: text('GWEN_SKILLS_DIR', ''),
    // No default: the persona lives outside this repo. See persona/README.txt.
    persona: readFileSync(text('GWEN_PERSONA_FILE'), 'utf8').trim(),
    ownerName: text('GWEN_OWNER_NAME', 'Rick'),
    timeZone: timeZone('GWEN_TIMEZONE', 'UTC'),
    adapters,
    buzz: adapters.includes('buzz')
      ? {
          relayUrl: text('BUZZ_RELAY_URL'),
          privateKey: text('BUZZ_PRIVATE_KEY'),
          ownerPubkey: text('BUZZ_OWNER_PUBKEY').toLowerCase(),
        }
      : null,
    telegram: adapters.includes('telegram')
      ? {
          token: text('TELEGRAM_BOT_TOKEN'),
          owner: text('TELEGRAM_OWNER').replace(/^@/, '').toLowerCase(),
        }
      : null,
    census: {
      email: text('GWEN_CENSUS_EMAIL', 'rick@theashfords.org'),
      sheetName: text('GWEN_CENSUS_SHEET_NAME', 'Mailing list census'),
    },
  };
}
