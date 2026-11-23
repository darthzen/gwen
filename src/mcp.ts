import { hasExecuteFunction, isGeneratorTool, type ToolWithExecute, type ToolWithGenerator } from '@openrouter/agent';
import { createMCPTools, type MCPToolsHandle } from '@openrouter/agent/mcp';
import { z } from 'zod';
import type { McpServerRef } from './skills.js';

// The MCP servers Gwen's skills name. A server is connected the first time a
// skill that names it is loaded, and the connection is kept. Nothing here is
// passed to the model as a tool definition: skill_tool calls through this
// class, so a server costs no context until its skill is loaded.

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpToolInfo {
  server: string;
  tool: string;
  description: string;
  /** JSON Schema of the tool's arguments. */
  arguments: unknown;
}

/** A tool's argument schema as JSON Schema, without the line that only names the dialect. */
function schemaOf(schema: z.core.$ZodType): unknown {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { unrepresentable: 'any' });
  return rest;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Run a tool to its result. A tool that reports progress is a generator: its
 * result is what it returns, or its last yield when it returns nothing.
 */
async function run(tool: ToolWithExecute | ToolWithGenerator, args: unknown): Promise<unknown> {
  if (!isGeneratorTool(tool)) return tool.function.execute(args as never);
  const steps = tool.function.execute(args as never);
  let last: unknown;
  for (;;) {
    const step = await steps.next();
    if (step.done) return step.value ?? last;
    last = step.value;
  }
}

export class McpHub {
  private refs = new Map<string, McpServerRef>();
  private handles = new Map<string, Promise<MCPToolsHandle>>();

  /**
   * Make the servers known. Two skills may name the same server only with the
   * same address; a second address under one name is refused, because
   * skill_tool addresses a server by name alone.
   */
  constructor(refs: Iterable<McpServerRef>, private version = '0') {
    for (const ref of refs) {
      const known = this.refs.get(ref.name);
      if (known && known.url !== ref.url) {
        throw new Error(`mcp server name ${ref.name} is used for both ${known.url} and ${ref.url}`);
      }
      // Tool lists from two skills add up; an empty list (everything) wins.
      const tools = known ? (known.tools.length && ref.tools.length ? [...new Set([...known.tools, ...ref.tools])] : []) : ref.tools;
      this.refs.set(ref.name, { ...ref, tools });
    }
  }

  get servers(): string[] {
    return [...this.refs.keys()];
  }

  private connect(name: string): Promise<MCPToolsHandle> {
    const ref = this.refs.get(name);
    if (!ref) {
      const known = this.servers.join(', ') || 'none';
      return Promise.reject(new Error(`no MCP server named ${JSON.stringify(name)}; servers your skills name: ${known}`));
    }
    let handle = this.handles.get(name);
    if (!handle) {
      const token = ref.bearerEnv ? process.env[ref.bearerEnv]?.trim() : '';
      if (ref.bearerEnv && !token) {
        return Promise.reject(new Error(`mcp server ${name}: environment variable ${ref.bearerEnv} is not set`));
      }
      handle = withTimeout(
        createMCPTools({
          url: ref.url,
          transport: 'streamableHttp',
          clientInfo: { name: 'gwen', version: this.version },
          ...(token ? { auth: { kind: 'bearer' as const, token } } : {}),
          ...(ref.tools.length ? { includeTools: ref.tools } : {}),
        }),
        CONNECT_TIMEOUT_MS,
        `connecting to mcp server ${name}`,
      );
      this.handles.set(name, handle);
      // A failed connection is not kept: the next use tries again.
      handle.catch(() => this.drop(name, handle));
    }
    return handle;
  }

  private drop(name: string, handle: Promise<MCPToolsHandle> | undefined): void {
    if (this.handles.get(name) !== handle) return;
    this.handles.delete(name);
    handle?.then((h) => h.close()).catch(() => {});
  }

  /** The tools one server offers. Connects if needed; rejects when the server cannot be reached. */
  async list(server: string): Promise<McpToolInfo[]> {
    const handle = await this.connect(server);
    return handle.tools.filter(hasExecuteFunction).map((t) => ({
      server,
      tool: t.function.name,
      description: t.function.description ?? '',
      arguments: schemaOf(t.function.inputSchema),
    }));
  }

  /**
   * Call one tool. Rejects with a message written for the model: an unknown
   * tool lists the real ones, bad arguments say which field is wrong.
   */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = this.connect(server);
    const handle = await connection;
    const found = handle.tools.filter(hasExecuteFunction).find((t) => t.function.name === tool);
    if (!found) {
      const names = handle.tools.filter(hasExecuteFunction).map((t) => t.function.name).join(', ');
      throw new Error(`mcp server ${server} has no tool ${JSON.stringify(tool)}; it has: ${names}`);
    }
    const parsed = z.safeParse(found.function.inputSchema, args);
    if (!parsed.success) {
      throw new Error(`arguments for ${server}/${tool} are not valid: ${z.prettifyError(parsed.error)}`);
    }
    try {
      return await withTimeout(run(found, parsed.data), CALL_TIMEOUT_MS, `${server}/${tool}`);
    } catch (e) {
      // The connection may be the cause (a restarted server forgets the
      // session), so the next call starts from a new one.
      this.drop(server, connection);
      throw e;
    }
  }

  async close(): Promise<void> {
    const open = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(open.map((h) => h.then((handle) => handle.close())));
  }
}
