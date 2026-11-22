import { callModel, type OpenRouter } from '@openrouter/agent';
import type { ChatAdapter, Incoming, ReplyTarget } from './adapters/types.js';
import type { Config } from './config.js';
import { RecentLines, frameJobResult, frameMessage } from './frame.js';
import { routeMessage } from './jev.js';
import { log, errText } from './log.js';
import { Hindsight } from './memory.js';
import { createClient, finish, maxSteps, modelFields } from './openrouter.js';
import { KeyedQueue } from './queue.js';
import { Research } from './research.js';
import { Store, type Job } from './store.js';
import { memoryTools } from './tools/memory.js';
import { researchTools } from './tools/research.js';
import { webTools } from './tools/web.js';

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

const MAX_REPLY_TOKENS = 2048;
const ERROR_CHARS = 200;

// This model is known to return empty turns now and then. Silence is the one
// outcome the user cannot interpret.
const EMPTY_REPLY = 'I came back with nothing on that one. Ask me again, or rephrase it.';

/** One line of the turn log: timings, sizes and outcomes, never message text. */
type TurnRecord = Record<string, unknown>;

export class Gwen {
  private client: OpenRouter;
  private store: Store;
  private memory: Hindsight;
  private research: Research;
  private web: ReturnType<typeof webTools>;
  private adapters = new Map<string, ChatAdapter>();
  private recent = new RecentLines();
  private turns = new KeyedQueue((conversationId, e) =>
    log.error('turn crashed', { conversationId, error: errText(e) }),
  );

  constructor(private cfg: Config) {
    this.client = createClient(cfg.openrouterKey);
    this.store = new Store(cfg.dataDir);
    this.memory = new Hindsight(cfg.memory);
    this.web = webTools(cfg.web);
    this.research = new Research(cfg.research, this.client, this.store, this.web, (job) => this.deliver(job));
  }

  register(adapter: ChatAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Run once at boot, after the adapters are registered. */
  recover(): void {
    for (const job of this.research.recover()) this.deliver(job);
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

  /** Answer a message from a person. */
  private async answer(target: ReplyTarget, message: Incoming): Promise<void> {
    const started = Date.now();
    const [prefetch, routing] = await Promise.all([
      this.memory.prefetch(message.text),
      routeMessage(this.cfg.jev, this.cfg.openrouterKey, message.text, this.recent.text(target.conversationId)),
    ]);
    this.recent.add(target.conversationId, message.senderName, message.text);

    const input = frameMessage({
      senderName: message.senderName,
      text: message.text,
      memories: prefetch.memories,
      routing,
      now: new Date(),
    });
    await this.respond(target, input, {
      kind: 'message',
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
      const sent = await this.respond(job, frameJobResult(job, this.cfg.ownerName), { kind: 'job-result', job: job.id });
      if (sent) this.research.markDelivered(job);
    });
  }

  /**
   * Run the front model on `input` and post its reply. Never throws: a failure
   * is reported to the user and logged. Returns whether a message was posted.
   */
  private async respond(target: ReplyTarget, input: string, record: TurnRecord): Promise<boolean> {
    const started = Date.now();
    record.conversationId = target.conversationId;
    const adapter = this.adapters.get(target.adapter);
    if (!adapter) {
      log.error('turn has no adapter to reply through', { ...record, adapter: target.adapter });
      return false;
    }
    const send = (text: string) => adapter.send(target.conversationId, text, target.replyRef);
    const stopTyping = adapter.typing(target.conversationId, target.replyRef);
    let sent = false;
    try {
      const run = callModel(this.client, {
        ...modelFields(this.cfg.front, 'throughput'),
        instructions: this.cfg.persona,
        input,
        tools: this.tools(target),
        state: this.store.state(target.conversationId),
        stopWhen: maxSteps(this.cfg.front.maxSteps),
        maxOutputTokens: MAX_REPLY_TOKENS,
        sessionId: target.conversationId.slice(0, 256),
      });
      const { text, usage } = await finish(run);
      Object.assign(record, usage, { modelMs: Date.now() - started, emptyReply: !text || undefined });

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

  private tools(target: ReplyTarget) {
    return [
      ...this.web,
      ...researchTools(this.research, target),
      ...memoryTools(this.memory, this.cfg.ownerName, target.conversationId),
    ] as const;
  }
}
