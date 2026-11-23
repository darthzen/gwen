import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clip, fingerprint, shellQuote } from '../src/sandbox.js';

test('shellQuote makes any text one shell word', () => {
  assert.equal(shellQuote('echo hi'), "'echo hi'");
  assert.equal(shellQuote("it's $HOME"), "'it'\\''s $HOME'");
});

test('fingerprint matches the form ssh-keygen prints', () => {
  // sha256 of the empty string, base64 without padding.
  assert.equal(fingerprint(Buffer.alloc(0)), 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('short output is returned whole', () => {
  const clip = new Clip(4, 4);
  clip.add('abc');
  clip.add('def');
  assert.equal(clip.text(), 'abcdef');
  assert.equal(clip.truncated, false);
});

test('long output keeps its start and its end and says what was dropped', () => {
  const clip = new Clip(4, 4);
  for (const chunk of ['ab', 'cdef', 'ghij', 'klmn']) clip.add(chunk);
  assert.equal(clip.truncated, true);
  assert.equal(clip.text(), 'abcd\n[... 6 characters omitted ...]\nklmn');
});
