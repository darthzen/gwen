import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicTag } from '../src/memory.js';

test('a topic name and its tag form are the same topic', () => {
  assert.equal(topicTag('ADHD & Autism'), 'adhd-autism');
  assert.equal(topicTag('adhd-autism'), 'adhd-autism');
  assert.equal(topicTag('  The Body Keeps the Score!  '), 'the-body-keeps-the-score');
  assert.equal(topicTag('???'), '');
});
