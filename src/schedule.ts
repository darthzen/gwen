import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { ReplyTarget } from './adapters/types.js';
import { log } from './log.js';
import { safe, writeAtomic } from './store.js';

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  target: ReplyTarget;
  createdAt: string;
  lastRunAt?: string;
}

/** Persistent store for schedule entries, one JSON file per entry. */
export class ScheduleStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'schedules');
    mkdirSync(this.dir, { recursive: true });
  }

  save(s: Schedule): void {
    writeAtomic(join(this.dir, `${safe(s.id)}.json`), JSON.stringify(s, null, 2));
  }

  list(): Schedule[] {
    if (!existsSync(this.dir)) return [];
    const out: Schedule[] = [];
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Schedule);
      } catch {
        log.warn('schedule: skipping corrupt entry file', { file: f });
      }
    }
    return out;
  }

  get(id: string): Schedule | undefined {
    const path = join(this.dir, `${safe(id)}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Schedule;
    } catch {
      log.warn('schedule: corrupt entry file', { id });
      return undefined;
    }
  }

  delete(id: string): void {
    rmSync(join(this.dir, `${safe(id)}.json`), { force: true });
  }
}

/**
 * Validates a 5-field cron expression and rejects intervals shorter than
 * `minIntervalMs` by checking the gap between the first two next-runs.
 * Returns an error string, or undefined when the cron is acceptable.
 */
export function validateCron(cron: string, minIntervalMs: number, timeZone: string): string | undefined {
  try {
    const probe = new Cron(cron, { timezone: timeZone });
    const runs = probe.nextRuns(2);
    probe.stop();
    if (runs.length < 2 || !runs[0] || !runs[1]) return 'cron expression does not produce enough runs to verify interval';
    const gap = runs[1].getTime() - runs[0].getTime();
    if (gap < minIntervalMs) {
      return `cron fires every ${Math.round(gap / 1000)}s; minimum interval is ${Math.round(minIntervalMs / 1000)}s`;
    }
    return undefined;
  } catch (e) {
    return `invalid cron expression: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Manages croner timers for schedule entries. Started after gwen.recover(),
 * stopped on shutdown. When an entry fires it calls onFire with the entry.
 */
export class Scheduler {
  private timers = new Map<string, Cron>();
  private store: ScheduleStore;
  private timeZone: string;
  private minIntervalMs: number;

  constructor(
    store: ScheduleStore,
    timeZone: string,
    minIntervalMs: number,
    private onFire: (entry: Schedule) => void,
  ) {
    this.store = store;
    this.timeZone = timeZone;
    this.minIntervalMs = minIntervalMs;
  }

  /** Start a timer for one entry. Logs a missed-run line if the first run after the reference is already past. */
  startEntry(entry: Schedule): void {
    const timer = new Cron(entry.cron, { timezone: this.timeZone }, () => {
      const ref = this.store.get(entry.id);
      if (!ref) return;
      ref.lastRunAt = new Date().toISOString();
      this.store.save(ref);
      this.onFire(ref);
    });
    this.timers.set(entry.id, timer);

    const reference = new Date(entry.lastRunAt ?? entry.createdAt);
    const firstAfter = timer.nextRun(reference);
    if (firstAfter instanceof Date && firstAfter.getTime() < Date.now()) {
      log.info('schedule: missed run while down, not replayed', {
        id: entry.id,
        name: entry.name,
        missed: firstAfter.toISOString(),
      });
    }
  }

  /** Start timers for all stored entries. Called at boot. */
  start(): void {
    for (const entry of this.store.list()) {
      this.startEntry(entry);
    }
  }

  /** Stop a single timer (when an entry is deleted). */
  stopEntry(id: string): void {
    this.timers.get(id)?.stop();
    this.timers.delete(id);
  }

  /** Stop all timers. Called on shutdown. */
  stop(): void {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
  }

  /** Create a new entry, validate the cron, persist it, and start its timer. */
  create(name: string, cron: string, prompt: string, target: ReplyTarget): { entry?: Schedule; error?: string } {
    const err = validateCron(cron, this.minIntervalMs, this.timeZone);
    if (err) return { error: err };
    const entry: Schedule = {
      id: `s-${randomUUID().slice(0, 8)}`,
      name,
      cron,
      prompt,
      target,
      createdAt: new Date().toISOString(),
    };
    this.store.save(entry);
    this.startEntry(entry);
    return { entry };
  }

  /** Remove an entry and stop its timer. */
  delete(id: string): boolean {
    const entry = this.store.get(id);
    if (!entry) return false;
    this.stopEntry(id);
    this.store.delete(id);
    return true;
  }

  /** All stored entries. */
  list(): Schedule[] {
    return this.store.list();
  }
}
