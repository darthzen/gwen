import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamEvents$inboundSchema } from '@openrouter/sdk/models';
import { completeEvents } from '../src/local.js';

// The terminal event exactly as llama-server (build b11058) sends it.
const COMPLETED =
  'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1795399199,"status":"completed","model":"qwen","output":[{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"sides\\":20}","call_id":"call_1","name":"roll_dice"}],"usage":{"input_tokens":293,"output_tokens":63,"total_tokens":356,"input_tokens_details":{"cached_tokens":0}}}}';

function parse(line: string) {
  return StreamEvents$inboundSchema.parse(JSON.parse(line.slice(6))) as { type: string; isUnknown?: boolean };
}

test('the SDK does not recognise llama-server’s terminal event as sent', () => {
  assert.equal(parse(COMPLETED).isUnknown, true);
});

test('a completed terminal event is one the SDK recognises', () => {
  const [line] = completeEvents(COMPLETED).split('\n');
  const event = parse(line!);
  assert.equal(event.type, 'response.completed');
  assert.notEqual(event.isUnknown, true);
});

test('values the server did send are kept', () => {
  const event = JSON.parse(completeEvents(COMPLETED).slice(6));
  assert.equal(event.response.model, 'qwen');
  assert.equal(event.response.usage.input_tokens, 293);
  assert.equal(event.response.output[0].name, 'roll_dice');
});

test('event names, blank lines and non-JSON data pass through', () => {
  const body = 'event: response.created\ndata: [DONE]\n\ndata: {not json';
  assert.equal(completeEvents(body), body);
});

test('events are numbered in order', () => {
  const out = completeEvents('data: {"type":"a"}\n\ndata: {"type":"b"}').split('\n');
  assert.equal(JSON.parse(out[0]!.slice(6)).sequence_number, 0);
  assert.equal(JSON.parse(out[2]!.slice(6)).sequence_number, 1);
});
