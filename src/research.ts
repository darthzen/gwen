import { randomUUID } from 'node:crypto';
import { callModel, type OpenRouter } from '@openrouter/agent';
import type { ReplyTarget } from './adapters/types.js';
import type { ResearchConfig } from './config.js';
import type { Hindsight } from './memory.js';
import { finish, maxSteps, modelFields } from './openrouter.js';
import type { Store, Job } from './store.js';
import { log, errText } from './log.js';

// Background research. The Agent SDK can run a subagent as a background tool,
// but it only hands the result back while the parent run is still alive, and
// it has no host callback for "finished after the turn ended". Gwen has to
// reply "on it" and end the turn, so the child conversation is run here in
// host code instead: the job is a file on disk, it survives the front turn,
// and both success and failure reach onSettled.

const INSTRUCTIONS = `You are a research worker for a concierge assistant. You receive one question and work alone; nobody can answer follow-up questions.

Method: search, then read the pages that matter. Prefer primary sources (official docs, repositories, release notes, the vendor's own pages) over summaries of them. Check a claim against a second source when the answer depends on it.

Report: lead with the answer in two or three sentences. Then the supporting points, each with the URL it came from. Say plainly what you could not establish and what is uncertain. Do not pad. Do not invent a figure, date, version or URL: if you did not read it on a page in this session, leave it out or mark it unverified.`;

/** Added to the worker's input when its report will be kept as reference material. */
const LIBRARY_NOTE = `This report will be filed as reference material and read again later without this conversation. Write every point as a full sentence that stands on its own. Next to each URL name the kind of source (peer-reviewed study, clinical or official guidance, vendor documentation, news, personal account) and the year it was published when the page states one. Where good sources disagree, report both positions.`;

const MAX_REPORT_TOKENS = 4096;
const TOOL_TIMEOUT_MS = 60_000;

type WorkerTools = Parameters<typeof callModel>[1]['tools'];

function now(): string {
  return new Date().toISOString();
}

export class Research {
  private running = new Map<string, Promise<void>>();

  constructor(
    private cfg: ResearchConfig,
    private client: OpenRouter,
    private store: Store,
    private tools: WorkerTools,
    private memory: Hindsight,
    /** Called once per job when it ends, whether it succeeded or failed. */
    private onSettled: (job: Job) => void,
  ) {}

  /** `libraryTopic`, when given, files the finished report in the library under that topic. */
  start(target: ReplyTarget, question: string, context: string, libraryTopic?: string): Job {
    const job: Job = {
      ...target,
      id: `r-${randomUUID().slice(0, 8)}`,
      question,
      context,
      status: 'running',
      createdAt: now(),
      delivered: false,
      ...(libraryTopic ? { libraryTopic } : {}),
    };
    this.store.saveJob(job);
    const work = this.run(job).finally(() => this.running.delete(job.id));
    this.running.set(job.id, work);
    return job;
  }

  jobsFor(conversationId: string): Job[] {
    return this.store.listJobs().filter((job) => job.conversationId === conversationId);
  }

  markDelivered(job: Job): void {
    job.delivered = true;
    this.store.saveJob(job);
  }

  /**
   * Run once at boot. Jobs still marked running died with the previous
   * process and are failed; the return value is every settled job whose
   * result never reached the chat.
   */
  recover(): Job[] {
    const jobs = this.store.listJobs();
    for (const job of jobs) {
      if (job.status === 'running') this.settle(job, { error: 'Gwen restarted while this was running' });
    }
    return jobs.filter((job) => !job.delivered);
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Resolves when the jobs running now have settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  private async run(job: Job): Promise<void> {
    const started = Date.now();
    const deadline = AbortSignal.timeout(this.cfg.timeoutMs);
    try {
      const run = callModel(this.client, {
        ...modelFields(this.cfg),
        instructions: INSTRUCTIONS,
        input: `Question: ${job.question}\n\nContext from the conversation:\n${job.context || '(none given)'}\n\nToday is ${now().slice(0, 10)}.${job.libraryTopic ? `\n\n${LIBRARY_NOTE}` : ''}`,
        tools: this.tools,
        stopWhen: [maxSteps(this.cfg.maxSteps), ({ steps }) => costOf(steps) >= this.cfg.maxCostUsd],
        maxOutputTokens: MAX_REPORT_TOKENS,
        toolTimeoutMs: TOOL_TIMEOUT_MS,
        signal: deadline,
      });
      const { text, usage } = await finish(run);
      if (!text) throw new Error('the research model returned an empty report');
      job.usage = usage;
      this.settle(job, { report: text });
      await this.file(job);
    } catch (e) {
      const timedOut = deadline.aborted;
      this.settle(job, { error: timedOut ? `research timed out after ${this.cfg.timeoutMs} ms` : errText(e) });
    }
    log.info('research settled', {
      job: job.id,
      status: job.status,
      ms: Date.now() - started,
      model: this.cfg.model,
      ...job.usage,
      error: job.error,
      library: job.library,
    });
    this.onSettled(job);
  }

  /** File a finished report in the library when the job asked for it. A failure is recorded, not thrown. */
  private async file(job: Job): Promise<void> {
    if (!job.libraryTopic || !job.report) return;
    const source = `Research report by Gwen's research worker, ${now().slice(0, 10)}, job ${job.id}. Question: ${job.question}`;
    try {
      job.library = { filedAs: await this.memory.fileInLibrary(job.libraryTopic, job.report, source, job.id) };
    } catch (e) {
      job.library = { error: errText(e) };
    }
    this.store.saveJob(job);
  }

  private settle(job: Job, outcome: { report: string } | { error: string }): void {
    if ('report' in outcome) {
      job.status = 'done';
      job.report = outcome.report;
    } else {
      job.status = 'failed';
      job.error = outcome.error;
    }
    job.finishedAt = now();
    this.store.saveJob(job);
  }
}

function costOf(steps: readonly unknown[]): number {
  return steps.reduce<number>((sum, step) => sum + ((step as { usage?: { cost?: number } })?.usage?.cost ?? 0), 0);
}
