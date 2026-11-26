import { tool } from '@openrouter/agent';
import { z } from 'zod';
import { log, errText } from '../log.js';
import type { McpHub, McpToolInfo } from '../mcp.js';
import { Clip } from '../sandbox.js';
import type { Skill } from '../skills.js';

// Skills for the front model. load_skill returns a skill's procedure and, for
// a skill that names MCP servers, the list of their tools. skill_tool calls
// one of those tools. Offered only when at least one skill exists, and
// skill_tool only when at least one skill names a server.

/** Characters of an MCP tool's result handed back to the model: this much of the start and of the end. */
const RESULT_HEAD_CHARS = 6_000;
const RESULT_TAIL_CHARS = 6_000;

/** A tool result as text of bounded size, so one large answer cannot fill the model's context. */
export function clipResult(result: unknown): { result: string; truncated: boolean } {
  const clip = new Clip(RESULT_HEAD_CHARS, RESULT_TAIL_CHARS);
  clip.add(typeof result === 'string' ? result : (JSON.stringify(result) ?? String(result)));
  return { result: clip.text(), truncated: clip.truncated };
}

export function skillTools(skills: ReadonlyMap<string, Skill>, hub: McpHub) {
  if (skills.size === 0) return [] as const;
  const names = [...skills.keys()];

  const loadSkill = tool({
    name: 'load_skill',
    description: `Read one of your skills: the written procedure for a job, and the tools that come with it. Call it before doing a job your skills list covers, in the same turn. Skills: ${names.join(', ')}.`,
    inputSchema: z.object({ name: z.string().describe('A skill name from your skills list.') }),
    execute: async ({ name }) => {
      const skill = skills.get(name.trim());
      log.info('load_skill', { skill: name.trim(), found: Boolean(skill) });
      if (!skill) return { error: `no skill named ${JSON.stringify(name)}; your skills are: ${names.join(', ')}` };
      if (skill.mcp.length === 0) return { skill: skill.name, procedure: skill.body };

      const tools: McpToolInfo[] = [];
      const unreachable: { server: string; error: string }[] = [];
      await Promise.all(
        skill.mcp.map(async (ref) => {
          try {
            tools.push(...(await hub.list(ref.name)));
          } catch (e) {
            unreachable.push({ server: ref.name, error: errText(e) });
          }
        }),
      );
      return {
        skill: skill.name,
        procedure: skill.body,
        howToCallTools: 'Call skill_tool with a server and tool from this list and arguments that fit the tool\'s schema.',
        tools,
        ...(unreachable.length ? { unreachable } : {}),
      };
    },
  });

  if (hub.servers.length === 0) return [loadSkill] as const;

  const skillTool = tool({
    name: 'skill_tool',
    description:
      'Call a tool that one of your skills listed when you loaded it. Use only a server, a tool and argument names that load_skill returned in this conversation; if you have not loaded the skill, load it first.',
    inputSchema: z.object({
      server: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}).describe('The arguments, as the tool\'s schema defines them.'),
    }),
    execute: async ({ server, tool: toolName, arguments: args }) => {
      const started = Date.now();
      // Names and timing only: arguments and results can hold anything.
      const argsJson = JSON.stringify(args).slice(0, 300);
      const record = { server: server.trim(), tool: toolName.trim(), args: argsJson };
      try {
        const result = clipResult(await hub.call(record.server, record.tool, args));
        log.info('skill_tool', { ...record, ms: Date.now() - started, chars: result.result.length });
        return result;
      } catch (e) {
        log.error('skill_tool', { ...record, ms: Date.now() - started, error: errText(e) });
        return { error: errText(e) };
      }
    },
  });

  return [loadSkill, skillTool] as const;
}
