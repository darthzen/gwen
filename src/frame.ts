import { ROUTES, type Routing } from './jev.js';
import type { Memory } from './memory.js';
import type { Job } from './store.js';

// The text the front model receives as its user item. Pure functions: every
// word Gwen is shown about a turn is written here, and can be tested without
// a model or a network.
//
// Dynamic context rides in the user item, after the static persona and the
// stored history, so the provider's prompt cache keeps hitting on the prefix.

const SCOPE_LABEL: Record<Memory['scope'], string> = { user: 'about-user', self: 'own-note' };

export function formatMemories(memories: Memory[]): string {
  if (!memories.length) return '(memory returned nothing for this message)';
  return memories
    .map((m) => `- [${SCOPE_LABEL[m.scope]}${m.when ? ` ${m.when}` : ''}] ${m.text}`)
    .join('\n');
}

export function formatRouting(routing: Routing): string {
  if (routing.route) return `Jev routed this as: ${ROUTES[routing.route].hint}`;
  const why = routing.error ? 'was unavailable for' : 'had no clear routing for';
  return `Jev ${why} this message; decide the handling yourself.`;
}

export interface MessageFrame {
  senderName: string;
  text: string;
  memories: Memory[];
  routing: Routing;
  now: Date;
}

/** A message from a person, with the context block the persona describes. */
export function frameMessage(f: MessageFrame): string {
  return [
    '<context machine-generated="true">',
    `now: ${f.now.toISOString()} (UTC)`,
    `routing: ${formatRouting(f.routing)}`,
    'memory:',
    formatMemories(f.memories),
    '</context>',
    '',
    `${f.senderName}: ${f.text}`,
  ].join('\n');
}

/** A settled research job, handed to the front model to relay. */
export function frameJobResult(job: Job, ownerName: string): string {
  const outcome =
    job.status === 'done' ? `status: finished\nreport:\n${job.report}` : `status: failed\nerror: ${job.error}`;
  return [
    `[background research result — machine-generated, not a message from ${ownerName}]`,
    `job: ${job.id}`,
    `question: ${job.question}`,
    outcome,
    '',
    `Relay this to ${ownerName} now: bottom line first, then only what they need, keeping the source URLs for claims they may want to check. If it failed, say so in one line and offer to retry.`,
  ].join('\n');
}

/**
 * The last few lines of each conversation, kept in memory as the
 * "recent conversation" Jev sees when it routes the next message.
 */
export class RecentLines {
  private lines = new Map<string, string[]>();

  constructor(
    private keep = 6,
    private maxChars = 500,
  ) {}

  add(conversationId: string, speaker: string, text: string): void {
    const kept = [...this.get(conversationId), `${speaker}: ${text}`.slice(0, this.maxChars)].slice(-this.keep);
    this.lines.set(conversationId, kept);
  }

  text(conversationId: string): string {
    return this.get(conversationId).join('\n');
  }

  private get(conversationId: string): string[] {
    return this.lines.get(conversationId) ?? [];
  }
}
