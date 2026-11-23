import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log, errText } from './log.js';

// Skills: written procedures Gwen reads only when a job calls for one.
//
// A skill is one markdown file in GWEN_SKILLS_DIR. Its name and one-line
// description are always in her instructions (see skillIndex); its body costs
// tokens only in a turn where she calls load_skill. A skill can also name MCP
// servers. Their tools are listed to her when the skill loads and are called
// through skill_tool, so no tool definition is in her context until then.
//
// The file format is a header between two `---` lines, then the body:
//
//   ---
//   name: github
//   description: Read and change issues and pull requests on GitHub.
//   mcp: github http://github-mcp-server.ai.svc.cluster.local:8080/mcp bearer=GITHUB_MCP_TOKEN
//   mcp: docs http://docs-rag-mcp.ai.svc.cluster.local:8080/mcp tools=search,fetch
//   ---
//   The procedure, in markdown.
//
// `mcp` may repeat. Its value is a name for the server, the server's
// streamable-HTTP address, and two optional settings: `bearer=<ENV VAR>` sends
// that variable's value as a bearer token, so the token stays in the
// environment and out of the file; `tools=a,b` offers only those tools.

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface McpServerRef {
  /** What Gwen calls the server in skill_tool. */
  name: string;
  url: string;
  /** Environment variable that holds a bearer token. Empty for a server that wants none. */
  bearerEnv: string;
  /** Tools to offer. Empty offers every tool the server has. */
  tools: string[];
}

export interface Skill {
  name: string;
  description: string;
  mcp: McpServerRef[];
  body: string;
}

function parseMcp(value: string): McpServerRef {
  const [name, url, ...settings] = value.split(/\s+/);
  if (!name || !NAME.test(name)) throw new Error(`mcp server name must match ${NAME}; got ${JSON.stringify(name ?? '')}`);
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`mcp server ${name} needs an http(s) address`);
  const ref: McpServerRef = { name, url, bearerEnv: '', tools: [] };
  for (const setting of settings) {
    const [key, rest = ''] = setting.split(/=(.*)/s);
    if (key === 'bearer' && rest) ref.bearerEnv = rest;
    else if (key === 'tools' && rest) ref.tools = rest.split(',').filter(Boolean);
    else throw new Error(`mcp server ${name}: unknown setting ${JSON.stringify(setting)}`);
  }
  return ref;
}

/** Read one skill file. Throws with the reason when the file is not a valid skill. */
export function parseSkill(source: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error('no header: the file must start with a block between two --- lines');
  const skill: Skill = { name: '', description: '', mcp: [], body: match[2]!.trim() };
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const [key, value = ''] = line.split(/:\s*(.*)/s).map((part) => part.trim());
    if (key === 'name') skill.name = value;
    else if (key === 'description') skill.description = value;
    else if (key === 'mcp') skill.mcp.push(parseMcp(value));
    else throw new Error(`unknown header line ${JSON.stringify(line)}`);
  }
  if (!NAME.test(skill.name)) throw new Error(`name must match ${NAME}; got ${JSON.stringify(skill.name)}`);
  if (!skill.description) throw new Error('description is required');
  if (!skill.body) throw new Error('the body is empty');
  return skill;
}

/**
 * Every valid skill in a directory, by name. A file that is not a valid skill
 * is logged and left out: one bad skill must not stop Gwen from starting.
 * An empty `dir` means skills are off.
 */
export function loadSkills(dir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  if (!dir) return skills;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const skill = parseSkill(readFileSync(join(dir, file), 'utf8'));
      if (skills.has(skill.name)) throw new Error(`a skill named ${skill.name} already exists`);
      skills.set(skill.name, skill);
    } catch (e) {
      log.error('skill skipped', { file, error: errText(e) });
    }
  }
  return skills;
}

/** The part of Gwen's instructions that lists her skills. Empty when she has none. */
export function skillIndex(skills: ReadonlyMap<string, Skill>): string {
  if (skills.size === 0) return '';
  const lines = [...skills.values()].map((s) => `- ${s.name}: ${s.description}`);
  return [
    'Your skills. Each of these is a written procedure for one kind of job, kept outside this text. Before you do a job on this list, call load_skill with its name and follow what comes back. Do not work from what you remember of a skill: load it in the turn you use it.',
    ...lines,
  ].join('\n');
}
