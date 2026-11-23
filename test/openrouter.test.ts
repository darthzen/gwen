import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelFields } from '../src/openrouter.js';

const base = { maxSteps: 8, baseUrl: '', apiKey: '' };

test('a model with no effort configured sends no reasoning field', () => {
  const fields = modelFields({ ...base, model: '@preset/gwen-front' });
  assert.equal('reasoning' in fields, false);
  assert.equal('provider' in fields, false);
});

test('a configured effort is sent, for a preset too', () => {
  const fields = modelFields({ ...base, model: '@preset/gwen-front', effort: 'low' });
  assert.deepEqual(fields.reasoning, { effort: 'low' });
});

test('a plain slug gets the ZDR policy and its effort', () => {
  const fields = modelFields({ ...base, model: 'google/gemini-4-hydrogen', effort: 'low' }, 'throughput');
  assert.deepEqual(fields.reasoning, { effort: 'low' });
  assert.deepEqual(fields.provider, { zdr: true, dataCollection: 'deny', sort: 'throughput' });
});
