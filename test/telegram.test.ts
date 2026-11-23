import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunks, toTelegramHtml } from '../src/adapters/telegram/format.js';

test('bold, italic, inline code and links become Telegram HTML', () => {
  assert.equal(
    toTelegramHtml('**Done.** That was *quick*, see `ls -la` and [the docs](https://example.com/a?b=1&c=2).'),
    '<b>Done.</b> That was <i>quick</i>, see <code>ls -la</code> and <a href="https://example.com/a?b=1&amp;c=2">the docs</a>.',
  );
});

test('characters Telegram would read as markup are escaped', () => {
  assert.equal(toTelegramHtml('if a < b && b > c'), 'if a &lt; b &amp;&amp; b &gt; c');
});

test('code keeps its asterisks, underscores and angle brackets', () => {
  assert.equal(
    toTelegramHtml('Run:\n```bash\necho **hi** > a_file_b\n```\ndone'),
    'Run:\n<pre>echo **hi** &gt; a_file_b</pre>\ndone',
  );
  assert.equal(toTelegramHtml('use `snake_case_name` here'), 'use <code>snake_case_name</code> here');
});

test('headings become bold lines and list markers become bullets', () => {
  assert.equal(toTelegramHtml('## Plan\n- one\n* two'), '<b>Plan</b>\n• one\n• two');
});

test('underscores and asterisks inside words are left alone', () => {
  assert.equal(toTelegramHtml('GWEN_FRONT_MODEL is 2*3*4'), 'GWEN_FRONT_MODEL is 2*3*4');
});

test('a short reply is one message', () => {
  assert.deepEqual(chunks('  hello  '), ['hello']);
});

test('a long reply splits at a paragraph break and loses nothing', () => {
  const a = 'a'.repeat(60);
  const b = 'b'.repeat(60);
  assert.deepEqual(chunks(`${a}\n\n${b}`, 100), [a, b]);
});

test('text with no break is cut at the limit', () => {
  const parts = chunks('x'.repeat(250), 100);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
});
