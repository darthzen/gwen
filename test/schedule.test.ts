import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cron } from 'croner';
import { ScheduleStore, Scheduler, validateCron, type Schedule } from '../src/schedule.js';

const TZ = 'America/Chicago';
const MIN = 5 * 60 * 1000;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gwen-sched-'));
}

function entry(over: Partial<Schedule>): Schedule {
  return {
    id: 's-test1',
    name: 'test',
    cron: '0 9 * * *',
    prompt: 'do the thing',
    target: { adapter: 'cli', conversationId: 'conv1' },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

test('store round trip: save, list, get, delete', () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);
  const e = entry({});
  store.save(e);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('s-test1')?.name, 'test');
  store.delete('s-test1');
  assert.equal(store.list().length, 0);
  assert.equal(store.get('s-test1'), undefined);
  rmSync(dir, { recursive: true });
});

test('delete of a missing id does not throw', () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);
  assert.doesNotThrow(() => store.delete('s-nope'));
  rmSync(dir, { recursive: true });
});

test('a corrupt file is skipped and the rest still load', () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);
  store.save(entry({ id: 's-good' }));
  writeFileSync(join(dir, 'schedules', 's-bad.json'), '{ not json');
  const all = store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 's-good');
  assert.equal(store.get('s-bad'), undefined);
  rmSync(dir, { recursive: true });
});

test('validateCron rejects every-minute and garbage, accepts daily', () => {
  assert.match(validateCron('* * * * *', MIN, TZ)!, /minimum interval/);
  assert.match(validateCron('not a cron', MIN, TZ)!, /invalid/);
  assert.equal(validateCron('0 7 * * *', MIN, TZ), undefined);
});

test('a created entry fires at the right instant, calls onFire once, sets lastRunAt', async () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);
  const fired: Schedule[] = [];
  const sched = new Scheduler(store, TZ, MIN, (e) => fired.push(e));

  // Cron fields must be in Chicago local time (the timezone croner uses).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit',
    month: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Schedule for the next minute in Chicago local time.
  let nextMin = get('minute') + 1;
  let nextHr = get('hour');
  if (nextMin >= 60) { nextMin = 0; nextHr = (nextHr + 1) % 24; }
  const cron = `${nextMin} ${nextHr} ${get('day')} ${get('month')} *`;
  // Compute the UTC instant of that Chicago local time.
  const nextMinute = new Date(now);
  nextMinute.setMinutes(nextMin, 0, 0);
  nextMinute.setHours(nextHr);
  // Adjust: setMinutes/setHours use local (machine) time, but we need Chicago.
  // Use croner's nextRun to get the exact instant.
  const { Cron: C } = await import('croner');
  const probe = new C(cron, { timezone: TZ });
  const fireAt = probe.nextRun();
  probe.stop();
  assert.ok(fireAt instanceof Date);

  const { entry: created, error } = sched.create('tick', cron, 'ping', { adapter: 'cli', conversationId: 'conv1' });
  assert.ok(created, error);
  assert.ok(!error);

  await new Promise<void>((resolve) => setTimeout(resolve, fireAt.getTime() - Date.now() + 1500));
  sched.stop();

  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, created!.id);
  const stored = store.get(created!.id)!;
  assert.ok(stored.lastRunAt);
  rmSync(dir, { recursive: true });
});

test('a deleted entry does not fire', async () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);
  const fired: Schedule[] = [];
  const sched = new Scheduler(store, TZ, MIN, (e) => fired.push(e));

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit',
    month: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let nextMin = get('minute') + 1;
  let nextHr = get('hour');
  if (nextMin >= 60) { nextMin = 0; nextHr = (nextHr + 1) % 24; }
  const cron = `${nextMin} ${nextHr} ${get('day')} ${get('month')} *`;
  const { Cron: C } = await import('croner');
  const probe = new C(cron, { timezone: TZ });
  const fireAt = probe.nextRun();
  probe.stop();
  assert.ok(fireAt instanceof Date);

  const { entry: created } = sched.create('gone', cron, 'ping', { adapter: 'cli', conversationId: 'conv1' });
  assert.ok(created);
  sched.delete(created!.id);

  await new Promise<void>((resolve) => setTimeout(resolve, fireAt.getTime() - Date.now() + 1500));
  sched.stop();

  assert.equal(fired.length, 0);
  rmSync(dir, { recursive: true });
});

test('missed-run line is logged for an entry whose lastRunAt is two days old', async () => {
  const dir = tmpDir();
  const store = new ScheduleStore(dir);

  // Entry last ran 3 days ago; cron fires daily at 9am Chicago.
  // 9am Chicago = 15:00 UTC in winter (CST).
  const old = new Date();
  old.setDate(old.getDate() - 3);
  old.setUTCHours(15, 0, 0, 0);
  const e = entry({ lastRunAt: old.toISOString(), cron: '0 9 * * *' });
  store.save(e);

  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.includes('missed run')) lines.push(s);
    return true;
  }) as typeof process.stdout.write;

  const sched = new Scheduler(store, TZ, MIN, () => {});
  sched.start();
  sched.stop();

  process.stdout.write = origWrite;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /missed run while down/);
  rmSync(dir, { recursive: true });
});
