import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationState } from '@openrouter/agent';
import { MAX_ITEMS, trim } from '../src/store.js';

function stateOf(roles: string[]): ConversationState {
  return { messages: roles.map((role, i) => ({ role, content: String(i) })) } as unknown as ConversationState;
}
const roles = (s: ConversationState) => (s.messages as unknown as Array<{ role: string }>).map((m) => m.role);

test('a short history is returned untouched', () => {
  const state = stateOf(['user', 'assistant']);
  assert.equal(trim(state), state);
});

test('a long history is cut to start at a user message', () => {
  // Two items over the limit, and the first kept candidate is a tool result.
  const history = ['user', 'assistant', 'tool', 'assistant', ...Array(MAX_ITEMS - 2).fill(null).map((_, i) => (i % 2 ? 'assistant' : 'user'))];
  const kept = roles(trim(stateOf(history)));
  assert.equal(kept[0], 'user');
  assert.equal(kept.length, MAX_ITEMS - 2);
});

test('a long history with no user message to cut at is left whole', () => {
  const state = stateOf(Array(MAX_ITEMS + 5).fill('assistant'));
  assert.equal(trim(state), state);
});
