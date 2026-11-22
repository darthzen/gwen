import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createInitialState,
  serializeConversationState,
  deserializeConversationState,
} from '@openrouter/agent';
import type { ConversationState, StateAccessor } from '@openrouter/agent';
import type { ReplyTarget } from './adapters/types.js';
import type { Usage } from './openrouter.js';
import { log, errText } from './log.js';

// Plain files on a volume. One writer (this process), small objects, and the
// data has to be readable with `cat` when something goes wrong. Writes go to a
// temp file and are renamed into place so a crash never leaves half a file.

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export type JobStatus = 'running' | 'done' | 'failed';

export interface Job extends ReplyTarget {
  id: string;
  question: string;
  context: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  report?: string;
  error?: string;
  delivered: boolean;
  usage?: Usage;
}

/** History is trimmed to this many items, cut at a user message. */
export const MAX_ITEMS = 80;

export class Store {
  private convDir: string;
  private jobDir: string;

  constructor(dataDir: string) {
    this.convDir = join(dataDir, 'conversations');
    this.jobDir = join(dataDir, 'jobs');
    mkdirSync(this.convDir, { recursive: true });
    mkdirSync(this.jobDir, { recursive: true });
  }

  state(conversationId: string): StateAccessor {
    const path = join(this.convDir, `${safe(conversationId)}.json`);
    return {
      load: async (): Promise<ConversationState | null> => {
        if (!existsSync(path)) return createInitialState(conversationId);
        try {
          const s = deserializeConversationState(readFileSync(path, 'utf8'));
          return trim(s);
        } catch (e) {
          // An unreadable history must not stop Gwen answering. Keep the bad
          // file for inspection and start the conversation again.
          log.error('conversation state unreadable, starting fresh', { conversationId, error: errText(e) });
          renameSync(path, `${path}.corrupt-${Date.now()}`);
          return createInitialState(conversationId);
        }
      },
      save: async (s: ConversationState): Promise<void> => {
        writeAtomic(path, serializeConversationState(s));
      },
    };
  }

  saveJob(job: Job): void {
    writeAtomic(join(this.jobDir, `${safe(job.id)}.json`), JSON.stringify(job, null, 2));
  }

  listJobs(): Job[] {
    return readdirSync(this.jobDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.jobDir, f), 'utf8')) as Job)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export function trim(s: ConversationState): ConversationState {
  const items = s.messages as unknown as Array<{ role?: string }>;
  if (!Array.isArray(items) || items.length <= MAX_ITEMS) return s;
  // Cut at a user message so the kept history never starts with an orphaned
  // tool result or half a tool round.
  let cut = items.length - MAX_ITEMS;
  while (cut < items.length && items[cut]?.role !== 'user') cut++;
  if (cut >= items.length) return s;
  return { ...s, messages: items.slice(cut) as unknown as ConversationState['messages'] };
}
