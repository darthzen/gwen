import { callModel, type OpenRouter } from '@openrouter/agent';
import type { ChatAdapter, Incoming, ReplyTarget } from './adapters/types.js';
import type { Config } from './config.js';
import { RecentLines, frameJobResult, frameMessage } from './frame.js';
import { Budget, Handoffs, frameCapped, frameInterrupted, frameResume, handoffDirective, stamp, type Pending } from './handoff.js';
import { routeMessage } from './jev.js';
import { log, errText } from './log.js';
import { McpHub } from './mcp.js';
import { Hindsight } from './memory.js';
import { createClient, finish, maxSteps, modelFields } from './openrouter.js';
import { KeyedQueue } from './queue.js';
import { Research } from './research.js';
import { Sandbox } from './sandbox.js';
import { loadSkills, skillIndex } from './skills.js';
import { Store, type Job } from './store.js';
import { Transcript } from './transcript.js';
import { historyTools } from './tools/history.js';
import { libraryTools } from './tools/library.js';
import { memoryTools } from './tools/memory.js';
import { researchTools } from './tools/research.js';
import { sandboxTools } from './tools/sandbox.js';
import { skillTools } from './tools/skills.js';
import { webTools } from './tools/web.js';
import { ScheduleStore, Scheduler, type Schedule } from './schedule.js';
import { scheduleTools } from './tools/schedule.js';
import { handoffTools } from './tools/handoff.js';

// The core. One front-model turn per incoming message:
//
//   message ─┬─ Hindsight recall ─┐
//            └─ Jev routing ──────┴─> front model (tools) ─> reply
//
// Recall and routing run concurrently and are bounded by timeouts, so they add
// the slower of the two to the turn and nothing to the model's round count.
// The reply is whatever text the model ends with; the host posts it. The model
// never spends a round on sending a message.
//
// A finished research job comes back the same way: it becomes one more
// front-model turn in the conversation that started it.
//
// A run that hits a limit while still calling tools ends in a handoff note
// instead of a reply; the conversation is cleared and one more turn is queued
// to carry the task on from the note. See handoff.ts.

const ERROR_CHARS = 200;

// This model is known to return empty turns now and then. Silence is the one
// outcome the user cannot interpret.
const EMPTY_REPLY = 'I came back with nothing on that one. Ask me again, or rephrase it.';

/** One line of the turn log: timings, sizes and outcomes, never message text. */
type TurnRecord = Record<string, unknown>;

export class Gwen {
  private client: OpenRouter;
  private store: Store;
  private transcript: Transcript;
  private memory: Hindsight;
  private research: Research;
  private web: ReturnType<typeof webTools>;
  /** Empty when no sandbox is configured. */
  private sandbox: ReturnType<typeof sandboxTools> | readonly [];
  /** Empty when there are no skills. */
  private skills: ReturnType<typeof skillTools>;
  private mcp: McpHub;
  /** The persona, followed by the list of skills when there are any. */
  private instructions: string;
  private adapters = new Map<string, ChatAdapter>();
  private recent = new RecentLines();
  private turns = new KeyedQueue((conversationId, e) =>
    log.error('turn crashed', { conversationId, error: errText(e) }),
  );
  private schedule: Scheduler;
  private handoffs: Handoffs;
  /** Automatic resumes in a row, per conversation. A message from a person starts it again. */
  private chain = new Map<string, number>();

  constructor(private cfg: Config) {
    this.client = createClient(cfg.openrouterKey, cfg.front);
    this.store = new Store(cfg.dataDir);
    this.transcript = new Transcript(cfg.dataDir);
    this.handoffs = new Handoffs(cfg.dataDir, cfg.handoff);
    const backfilled = this.transcript.backfill(this.store.rawConversations());
    if (backfilled) log.info('transcript backfilled from conversation state', { lines: backfilled });
    this.memory = new Hindsight(cfg.memory);
    this.web = webTools(cfg.web);
    this.sandbox = cfg.sandbox ? sandboxTools(new Sandbox(cfg.sandbox)) : [];
    const skills = loadSkills(cfg.skillsDir);
    this.mcp = new McpHub([...skills.values()].flatMap((skill) => skill.mcp));
    this.skills = skillTools(skills, this.mcp);
    this.instructions = [cfg.persona, skillIndex(skills)].filter(Boolean).join('\n\n');
    log.info('skills loaded', { skills: [...skills.keys()], mcpServers: this.mcp.servers });
    const researchClient = createClient(cfg.openrouterKey, cfg.research);
    this.research = new Research(cfg.research, researchClient, this.store, this.web, this.memory, (job) =>
      this.deliver(job),
    );
    this.schedule = new Scheduler(
      new ScheduleStore(cfg.dataDir),
      cfg.timeZone,
      5 * 60 * 1000,
      (entry) => this.deliverScheduled(entry),
    );
  }

  register(adapter: ChatAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Run once at boot, after the adapters are registered. */
  recover(): void {
    for (const job of this.research.recover()) this.deliver(job);
    // A resume that was queued when the last process died.
    for (const pending of this.handoffs.all()) if (!pending.capped) this.queueResume(pending);
    this.schedule.start();
  }

  onMessage(adapter: ChatAdapter, message: Incoming): void {
    const target: ReplyTarget = {
      adapter: adapter.name,
      conversationId: message.conversationId,
      replyRef: message.replyRef,
    };
    this.turns.push(target.conversationId, () => this.answer(target, message));
  }

  /** Resolves when no turn is queued and no research is running. */
  async idle(): Promise<void> {
    // A turn can start research and a settling job queues a delivery turn, so
    // drain both until neither has anything left.
    while (this.research.busy || this.turns.busy) {
      await this.research.idle();
      await this.turns.drain();
    }
  }

  /** Close what the service holds open besides the adapters. */
  async stop(): Promise<void> {
    this.schedule.stop();
    await this.mcp.close();
  }

  /** Answer a message from a person. */
  private async answer(target: ReplyTarget, message: Incoming): Promise<void> {
    const started = Date.now();
    this.record(target, message.senderName, message.text, new Date(started));
    const [prefetch, routing] = await Promise.all([
      this.memory.prefetch(message.text),
      routeMessage(this.cfg.jev, this.cfg.openrouterKey, message.text, this.recent.text(target.conversationId)),
    ]);
    this.recent.add(target.conversationId, message.senderName, message.text);

    const framed = frameMessage({
      senderName: message.senderName,
      text: message.text,
      memories: prefetch.memories,
      routing,
      now: new Date(),
    });
    // A task waiting to resume: show this turn its note. A queued resume stays
    // queued behind this turn; a note stopped at the limit is used up here.
    const conversationId = target.conversationId;
    this.chain.delete(conversationId);
    this.handoffs.restart(conversationId);
    const pending = this.handoffs.pending(conversationId);
    if (pending?.capped) this.handoffs.clear(conversationId);
    const input = pending ? `${frameInterrupted(pending)}\n\n${framed}` : framed;
    const extra = pending && !pending.capped ? handoffTools(() => this.handoffs.clear(conversationId)) : ([] as const);
    await this.respond(target, input, new Date(started), extra, {
      kind: 'message',
      interrupted: pending?.id,
      prepMs: Date.now() - started,
      recallMs: prefetch.ms,
      memories: prefetch.memories.length,
      recallError: prefetch.error,
      jevMs: routing.ms,
      route: routing.route,
      jevPicked: routing.picked,
      jevConfidence: routing.confidence,
      jevError: routing.error,
    });
  }

  /** Hand a settled research job to the front model to relay. */
  private deliver(job: Job): void {
    this.turns.push(job.conversationId, async () => {
      const sent = await this.respond(job, frameJobResult(job, this.cfg.ownerName), new Date(), [], { kind: 'job-result', job: job.id });
      if (sent) this.research.markDelivered(job);
    });
  }

  /** Fire a scheduled task: queue a normal turn with the stored target. */
  deliverScheduled(entry: Schedule): void {
    if (!this.adapters.has(entry.target.adapter)) {
      log.info('schedule skipped: adapter not active', {
        id: entry.id,
        name: entry.name,
        adapter: entry.target.adapter,
      });
      return;
    }
    const localTime = new Date().toLocaleString('en-US', {
      timeZone: this.cfg.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const input = `[Scheduled task ${entry.name}, fired ${localTime}] ${entry.prompt}`;
    this.turns.push(entry.target.conversationId, async () => {
      await this.respond(entry.target, input, new Date(), [], { kind: 'schedule', id: entry.id, name: entry.name });
    });
  }

  /** Queue the turn that carries a task on from its handoff note. */
  private queueResume(pending: Pending): void {
    const { conversationId } = pending.target;
    this.turns.push(conversationId, async () => {
      // Cancelled, or replaced by a newer note, while this waited its turn.
      const current = this.handoffs.pending(conversationId);
      if (current?.id !== pending.id) return;
      this.handoffs.clear(conversationId);
      this.chain.set(conversationId, current.resume);
      const input = frameResume(current, this.cfg.handoff.maxResumes, this.cfg.ownerName);
      await this.respond(current.target, input, new Date(), [], { kind: 'resume', handoff: current.id, resume: current.resume });
    });
  }

  /**
   * A run ended in a handoff note. Save it, clear the conversation, and queue
   * the resume, or tell the owner when the limit on resumes is reached.
   */
  private async handOff(target: ReplyTarget, note: string, budget: Budget, record: TurnRecord, send: (text: string) => Promise<void>): Promise<void> {
    const { conversationId } = target;
    const at = new Date();
    const pending = this.handoffs.save(target, note, budget.reason!, this.chain.get(conversationId) ?? 0, at);
    const archived = this.store.retire(conversationId, `handoff-${stamp(at)}`);
    Object.assign(record, {
      handoff: pending.id,
      handoffReason: pending.reason,
      handoffChars: note.length,
      nextResume: pending.resume,
      capped: pending.capped || undefined,
      archived,
    });
    if (pending.capped) {
      this.chain.delete(conversationId);
      await send(frameCapped(pending, this.cfg.handoff.maxResumes));
    } else {
      this.queueResume(pending);
    }
  }

  /**
   * Run the front model on `input` and post its reply. Never throws: a failure
   * is reported to the user and logged. Returns whether the turn was dealt
   * with: a message was posted, or the task was handed off to a resume turn.
   * `asOf` is when the turn began: search_history sees nothing later.
   */
  private async respond(
    target: ReplyTarget,
    input: string,
    asOf: Date,
    extraTools: ReturnType<typeof handoffTools> | readonly [],
    record: TurnRecord,
  ): Promise<boolean> {
    const started = Date.now();
    record.conversationId = target.conversationId;
    const adapter = this.adapters.get(target.adapter);
    if (!adapter) {
      log.error('turn has no adapter to reply through', { ...record, adapter: target.adapter });
      return false;
    }
    const send = async (text: string): Promise<void> => {
      await adapter.send(target.conversationId, text, target.replyRef);
      this.record(target, 'Gwen', text, new Date());
    };
    const stopTyping = adapter.typing(target.conversationId, target.replyRef);
    let sent = false;
    const budget = this.handoffs.enabled
      ? new Budget({
          maxSteps: this.cfg.front.maxSteps,
          inputTokens: this.cfg.handoff.inputTokens,
          items: this.cfg.handoff.items,
        })
      : undefined;
    try {
      const run = callModel(this.client, {
        ...modelFields(this.cfg.front, 'throughput'),
        instructions: this.instructions,
        input,
        tools: [...this.tools(target, asOf), ...extraTools],
        state: this.store.state(target.conversationId),
        stopWhen: budget ? budget.stopWhen : maxSteps(this.cfg.front.maxSteps),
        // What the model is asked for when a limit stops it mid-task.
        ...(budget ? { allowFinalResponse: handoffDirective(this.cfg.ownerName) } : {}),
        maxOutputTokens: this.cfg.front.maxOutputTokens,
        sessionId: target.conversationId.slice(0, 256),
      });
      const { text, usage } = await finish(run);
      Object.assign(record, usage, { modelMs: Date.now() - started, emptyReply: !text || undefined });

      if (budget?.handedOff(usage.rounds) && text) {
        await this.handOff(target, text, budget, record, async (message) => {
          await send(message);
          this.recent.add(target.conversationId, 'Gwen', message);
        });
        return (sent = true);
      }

      const reply = text || EMPTY_REPLY;
      await send(reply);
      sent = true;
      this.recent.add(target.conversationId, 'Gwen', reply);
      record.replyChars = reply.length;
    } catch (e) {
      record.error = errText(e);
      if (!sent) {
        sent = await send(`I hit an error and could not finish that: ${errText(e).slice(0, ERROR_CHARS)}`).then(
          () => true,
          (sendError) => {
            record.sendError = errText(sendError);
            return false;
          },
        );
      }
    } finally {
      stopTyping();
      record.totalMs = Date.now() - started + (typeof record.prepMs === 'number' ? record.prepMs : 0);
      (record.error ? log.error : log.info)('turn', record);
    }
    return sent;
  }

  /** Add a line to the permanent transcript: something a person said, or something Gwen sent. */
  private record(target: ReplyTarget, speaker: string, text: string, at: Date): void {
    this.transcript.append({
      t: at.toISOString(),
      adapter: target.adapter,
      conversation: target.conversationId,
      speaker,
      text,
    });
  }

  private tools(target: ReplyTarget, asOf: Date) {
    return [
      ...this.web,
      ...this.sandbox,
      ...this.skills,
      ...researchTools(this.research, target),
      ...memoryTools(this.memory, this.cfg.ownerName, target.conversationId),
      ...historyTools(this.transcript, {
        ownerName: this.cfg.ownerName,
        timeZone: this.cfg.timeZone,
        platforms: this.cfg.adapters,
        asOf,
      }),
      ...(this.memory.enabled ? libraryTools(this.memory) : []),
      ...scheduleTools(this.schedule, target, this.cfg.timeZone),
    ] as const;
  }
}
