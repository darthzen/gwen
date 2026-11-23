import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpHub } from '../src/mcp.js';
import { loadSkills, parseSkill, skillIndex } from '../src/skills.js';
import { clipResult, skillTools } from '../src/tools/skills.js';

const PLAIN = '---\nname: build-image\ndescription: Build a container image.\n---\nUse podman.\n';

test('a skill file gives a name, a description and a body', () => {
  assert.deepEqual(parseSkill(PLAIN), {
    name: 'build-image',
    description: 'Build a container image.',
    mcp: [],
    body: 'Use podman.',
  });
});

test('a description may contain a colon', () => {
  const skill = parseSkill('---\nname: a\ndescription: Two parts: this and that.\n---\nbody');
  assert.equal(skill.description, 'Two parts: this and that.');
});

test('mcp lines name servers, with an optional token variable and tool list', () => {
  const skill = parseSkill(
    '---\nname: gh\ndescription: d\nmcp: github http://gh.ai.svc:8080/mcp bearer=GH_TOKEN tools=a,b\nmcp: docs https://docs.example/mcp\n---\nbody',
  );
  assert.deepEqual(skill.mcp, [
    { name: 'github', url: 'http://gh.ai.svc:8080/mcp', bearerEnv: 'GH_TOKEN', tools: ['a', 'b'] },
    { name: 'docs', url: 'https://docs.example/mcp', bearerEnv: '', tools: [] },
  ]);
});

test('a file that is not a valid skill says why', () => {
  assert.throws(() => parseSkill('just text'), /no header/);
  assert.throws(() => parseSkill('---\nname: Bad Name\ndescription: d\n---\nbody'), /name must match/);
  assert.throws(() => parseSkill('---\nname: a\n---\nbody'), /description is required/);
  assert.throws(() => parseSkill('---\nname: a\ndescription: d\n---\n'), /body is empty/);
  assert.throws(() => parseSkill('---\nname: a\ndescription: d\ncolour: red\n---\nbody'), /unknown header line/);
  assert.throws(() => parseSkill('---\nname: a\ndescription: d\nmcp: k8s ftp://x\n---\nbody'), /http\(s\) address/);
  assert.throws(() => parseSkill('---\nname: a\ndescription: d\nmcp: k8s http://x token=abc\n---\nbody'), /unknown setting/);
});

test('a directory loads its valid skills and leaves the rest out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwen-skills-'));
  writeFileSync(join(dir, 'build-image.md'), PLAIN);
  writeFileSync(join(dir, 'broken.md'), 'no header here');
  writeFileSync(join(dir, 'notes.txt'), 'not a skill file');
  assert.deepEqual([...loadSkills(dir).keys()], ['build-image']);
  assert.equal(loadSkills('').size, 0);
});

test('the index lists each skill on one line, and is empty without skills', () => {
  const skills = new Map([['build-image', parseSkill(PLAIN)]]);
  assert.match(skillIndex(skills), /\n- build-image: Build a container image\.$/);
  assert.equal(skillIndex(new Map()), '');
});

test('tools offered match what exists: none, load_skill alone, or both', () => {
  const plain = new Map([['build-image', parseSkill(PLAIN)]]);
  const withServer = new Map([['gh', parseSkill('---\nname: gh\ndescription: d\nmcp: github http://gh/mcp\n---\nbody')]]);
  const names = (tools: readonly { function: { name: string } }[]) => tools.map((t) => t.function.name);
  assert.deepEqual(names(skillTools(new Map(), new McpHub([]))), []);
  assert.deepEqual(names(skillTools(plain, new McpHub([]))), ['load_skill']);
  assert.deepEqual(names(skillTools(withServer, new McpHub(withServer.get('gh')!.mcp))), ['load_skill', 'skill_tool']);
});

test('one server name cannot mean two addresses', () => {
  const ref = { name: 'k8s', bearerEnv: '', tools: [] };
  assert.throws(() => new McpHub([{ ...ref, url: 'http://a/mcp' }, { ...ref, url: 'http://b/mcp' }]), /used for both/);
  assert.deepEqual(new McpHub([{ ...ref, url: 'http://a/mcp' }, { ...ref, url: 'http://a/mcp' }]).servers, ['k8s']);
});

test('calling a server no skill names is an error that lists the real ones', async () => {
  const hub = new McpHub([{ name: 'k8s', url: 'http://a/mcp', bearerEnv: '', tools: [] }]);
  await assert.rejects(hub.call('nope', 'x', {}), /no MCP server named "nope"; servers your skills name: k8s/);
});

test('a server whose token variable is unset is refused before any connection', async () => {
  const hub = new McpHub([{ name: 'gh', url: 'http://a/mcp', bearerEnv: 'GWEN_TEST_UNSET_TOKEN', tools: [] }]);
  await assert.rejects(hub.list('gh'), /GWEN_TEST_UNSET_TOKEN is not set/);
});

test('a large tool result keeps its start and end', () => {
  assert.deepEqual(clipResult({ ok: true }), { result: '{"ok":true}', truncated: false });
  const big = clipResult('x'.repeat(20_000));
  assert.equal(big.truncated, true);
  assert.match(big.result, /8000 characters omitted/);
});
