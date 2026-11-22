import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyedQueue } from '../src/queue.js';

test('work for one key runs in order; another key is not held up', async () => {
  const order: string[] = [];
  const queue = new KeyedQueue(() => {});
  queue.push('a', async () => { await sleep(20); order.push('a1'); });
  queue.push('a', async () => { order.push('a2'); });
  queue.push('b', async () => { order.push('b1'); });
  assert.equal(queue.busy, true);
  await queue.drain();
  assert.deepEqual(order, ['b1', 'a1', 'a2']);
  assert.equal(queue.busy, false);
});

test('a failure is reported and does not block the next item', async () => {
  const errors: string[] = [];
  const done: string[] = [];
  const queue = new KeyedQueue((key, e) => errors.push(`${key}: ${(e as Error).message}`));
  queue.push('a', async () => { throw new Error('boom'); });
  queue.push('a', async () => { done.push('second'); });
  await queue.drain();
  assert.deepEqual(errors, ['a: boom']);
  assert.deepEqual(done, ['second']);
});
