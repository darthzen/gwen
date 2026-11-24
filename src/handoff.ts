import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ReplyTarget } from './adapters/types.js';
import type { HandoffConfig } from './config.js';
import { safe, writeAtomic } from './store.js';

// Handoff, clear, resume. A task that outgrows one run would otherwise end at
// the step limit with whatever the model had to say, and nothing would carry
// it on. Instead the host watches the run's budget, and when a limit is
// reached with tool calls still coming:
//
//   budget stop ─> model writes a handoff note (tools off)
//               ─> note saved, conversation state archived and cleared
//               ─> a resume turn is queued with the note as its input
//
// The host enforces all of it. The model is never asked to notice its own
// limits; it is only asked to write the note.

export type StopReason = 'steps' | 'tokens' | 'items';

/** The part of an SDK step the budget reads. */
interface Step {
  text?: string;
  toolCalls?: readonly unknown[];
  toolResults?: readonly unknown[];
  usage?: { inputTokens?: number } | null;
}

/** Watches one run and stops it at the first limit reached. */
export class Budget {
  /** Set when a limit stopped the run. */
  reason?: StopReason;
  private stepsAtStop = 0;

  constructor(private limits: { maxSteps: number; inputTokens: number; items: number }) {}

  /** The run's stop condition. A limit of 0 is off. */
  stopWhen = ({ steps }: { steps: readonly unknown[] }): boolean => {
    const reason = this.check(steps as readonly Step[]);
    if (!reason) return false;
    this.reason = reason;
    this.stepsAtStop = steps.length;
    return true;
  };

  private check(steps: readonly Step[]): StopReason | undefined {
    const { maxSteps, inputTokens, items } = this.limits;
    if (steps.length >= maxSteps) return 'steps';
    // The newest round's prompt size is the context in use; the run's total
    // is a sum over rounds and says nothing about how full the context is.
    const last = steps[steps.length - 1]?.usage?.inputTokens ?? 0;
    if (inputTokens > 0 && last >= inputTokens) return 'tokens';
    if (items > 0 && itemsAdded(steps) >= items) return 'items';
    return undefined;
  }

  /**
   * Whether the run ended on the forced, tool-less final request, so its text
   * is a handoff note and not a reply. The stop condition sees only finished
   * tool rounds. When it fires, the model's next response is already in hand:
   * if that response is plain text the run ends there (rounds = steps + 1);
   * if it calls tools, they run and the SDK makes one more request with the
   * handoff directive (rounds = steps + 2).
   */
  handedOff(rounds: number): boolean {
    return this.reason !== undefined && rounds >= this.stepsAtStop + 2;
  }
}

/** History items this run has added: its input, then each round's text, calls and results. */
export function itemsAdded(steps: readonly Step[]): number {
  return steps.reduce(
    (sum, step) => sum + (step.text ? 1 : 0) + (step.toolCalls?.length ?? 0) + (step.toolResults?.length ?? 0),
    1,
  );
}

/** What the model is told on the final, tool-less request of a run that hit a limit. */
export function handoffDirective(owner: string): string {
  return [
    'You have reached a resource limit for this turn, and tools are no longer available. Do not attempt to call any more tools.',
    'Your conversation history is about to be cleared. You will continue this task in a fresh turn, and the note you write now is the only thing you will have. Write that handoff note to yourself, in plain text, under these headings:',
    `Task: what ${owner} asked for, in their words where the wording matters, and what done looks like.`,
    'Done: what is finished, and what you verified.',
    'State: the exact name of everything you will need again: branches, file paths, directories, commands, URLs, job ids. Files in the sandbox survive; your memory of this conversation does not.',
    'Next: the next concrete step, then the steps after it, in order.',
    `Open: anything unresolved, and anything that needs ${owner}.`,
    'Write only the note. Keep it under 600 words.',
  ].join('\n\n');
}

/** A handoff waiting to be picked up. */
export interface Pending {
  id: string;
  target: ReplyTarget;
  /** Which automatic resume in a row this one is, from 1. */
  resume: number;
  /** True when the resume limit was reached: nothing is queued, a person has to continue it. */
  capped: boolean;
  reason: StopReason;
  text: string;
  at: string;
}

/** Input of the turn that resumes a task from its note. */
export function frameResume(pending: Pending, maxResumes: number, owner: string): string {
  return `[Automatic resume ${pending.resume} of ${maxResumes}. You ran out of room on a task and wrote the handoff note below; your earlier conversation was cleared. Continue the task from the note. ${owner} has not been told about this and has not sent a new message. When the task is finished, reply with the result for ${owner}: that reply is the only part of this they will see.]\n\n${pending.text}`;
}

/** Put in front of a person's message that arrives while a handoff is waiting. */
export function frameInterrupted(pending: Pending): string {
  const next = pending.capped
    ? 'You had reached the limit on automatic resumes and stopped. Answer the message below. Continue the task from the note only if it asks you to.'
    : 'You will continue the task automatically right after this turn. Answer the message below first. If it tells you to stop the task or changes what the task is, call cancel_resume.';
  return `[You ran out of room on a task and wrote the handoff note below; your earlier conversation was cleared. ${next}]\n\n${pending.text}\n\n[End of handoff note]`;
}

/** What the owner is told when the resume limit stops a task. */
export function frameCapped(pending: Pending, maxResumes: number): string {
  return `I stopped this task after ${maxResumes} automatic resumes without finishing it. Where it stands:\n\n${pending.text}\n\nTell me to continue and I will pick it up from here.`;
}

/**
 * Handoff notes on disk, one waiting note per conversation.
 *
 *   <conversation>.md            the latest note, for reading
 *   <conversation>.<time>.md     every note ever written
 *   <conversation>.pending.json  the note waiting to be resumed, if any
 */
export class Handoffs {
  private dir: string;

  constructor(dataDir: string, private cfg: HandoffConfig) {
    this.dir = join(dataDir, 'handoffs');
    mkdirSync(this.dir, { recursive: true });
  }

  get enabled(): boolean {
    return this.cfg.maxResumes > 0;
  }

  /** Record a new note. `resumesSoFar` is how many automatic resumes in a row led here. */
  save(target: ReplyTarget, text: string, reason: StopReason, resumesSoFar: number, at = new Date()): Pending {
    const resume = resumesSoFar + 1;
    const pending: Pending = {
      id: `h-${randomUUID().slice(0, 8)}`,
      target,
      resume,
      capped: resume > this.cfg.maxResumes,
      reason,
      text,
      at: at.toISOString(),
    };
    const name = safe(target.conversationId);
    writeAtomic(join(this.dir, `${name}.md`), `${text}\n`);
    writeAtomic(join(this.dir, `${name}.${stamp(at)}.md`), `${text}\n`);
    this.write(pending);
    return pending;
  }

  pending(conversationId: string): Pending | undefined {
    const path = this.path(conversationId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Pending;
    } catch {
      return undefined;
    }
  }

  /** A person spoke: the count of resumes in a row starts again. */
  restart(conversationId: string): void {
    const pending = this.pending(conversationId);
    if (pending && !pending.capped && pending.resume !== 1) this.write({ ...pending, resume: 1 });
  }

  clear(conversationId: string): void {
    rmSync(this.path(conversationId), { force: true });
  }

  /** Every waiting note. For re-queuing resumes after a restart. */
  all(): Pending[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.pending.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Pending];
        } catch {
          return [];
        }
      });
  }

  private write(pending: Pending): void {
    writeAtomic(this.path(pending.target.conversationId), JSON.stringify(pending, null, 2));
  }

  private path(conversationId: string): string {
    return join(this.dir, `${safe(conversationId)}.pending.json`);
  }
}

/** A timestamp that is safe in a file name and sorts by time. */
export function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
