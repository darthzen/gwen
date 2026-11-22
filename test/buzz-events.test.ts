import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import { KIND, Signer, replyTags, threadRootOf, type BuzzReplyRef, type Event } from '../src/adapters/buzz/events.js';

// A throwaway key, not Gwen's.
const signer = new Signer('11'.repeat(32));
const OWNER = 'ab'.repeat(32);
const ref = (over: Partial<BuzzReplyRef>): BuzzReplyRef => ({
  channel: 'chan', channelType: 'dm', eventId: 'trigger', threadRoot: null, ...over,
});
const incoming = (tags: string[][]) => ({ tags }) as Event;

test('thread root: top-level, direct reply to the root, nested reply', () => {
  assert.equal(threadRootOf(incoming([['h', 'chan']])), null);
  assert.equal(threadRootOf(incoming([['e', 'R', '', 'reply']])), 'R');
  assert.equal(threadRootOf(incoming([['e', 'R', '', 'root'], ['e', 'X', '', 'reply']])), 'R');
});

test('reply tags: flat in a DM, a new thread in a stream, in-thread stays in the thread', () => {
  assert.deepEqual(replyTags(ref({})), []);
  assert.deepEqual(replyTags(ref({ channelType: 'stream' })), [['e', 'trigger', '', 'reply']]);
  const inThread = [['e', 'R', '', 'root'], ['e', 'trigger', '', 'reply']];
  assert.deepEqual(replyTags(ref({ threadRoot: 'R' })), inThread);
  assert.deepEqual(replyTags(ref({ channelType: 'stream', threadRoot: 'R' })), inThread);
});

test('a message is a valid signed kind 9 addressed to the channel and the owner', () => {
  const event = signer.message(ref({}), OWNER, 'hello', 1_700_000_000_123);
  assert.equal(verifyEvent(event), true);
  assert.equal(event.kind, KIND.message);
  assert.equal(event.content, 'hello');
  assert.equal(event.created_at, 1_700_000_000);
  assert.deepEqual(event.tags, [['h', 'chan'], ['p', OWNER], ['ms', '1700000000123']]);
});

test('relay AUTH answers the challenge for the configured relay URL', () => {
  const event = signer.relayAuth('wss://relay.example', 'c-123');
  assert.equal(event.kind, KIND.relayAuth);
  assert.deepEqual(event.tags, [['relay', 'wss://relay.example'], ['challenge', 'c-123']]);
  assert.equal(event.content, '');
});

test('the HTTP auth header signs the URL and the body, with a fresh nonce each time', () => {
  const body = '[{"kinds":[39002]}]';
  const decode = (header: string) => JSON.parse(Buffer.from(header.replace(/^Nostr /, ''), 'base64').toString()) as Event;
  const first = decode(signer.httpAuthHeader('https://relay.example/query', body));
  const second = decode(signer.httpAuthHeader('https://relay.example/query', body));
  const tag = (e: Event, name: string) => e.tags.find((t) => t[0] === name)?.[1];
  assert.equal(verifyEvent(first), true);
  assert.equal(first.kind, KIND.httpAuth);
  assert.equal(tag(first, 'u'), 'https://relay.example/query');
  assert.equal(tag(first, 'method'), 'POST');
  assert.equal(tag(first, 'payload'), createHash('sha256').update(body).digest('hex'));
  assert.notEqual(tag(first, 'nonce'), tag(second, 'nonce'));
});

test('a malformed private key is refused without echoing it', () => {
  assert.throws(() => new Signer('nsec1notHex'), /64 hex characters/);
});
