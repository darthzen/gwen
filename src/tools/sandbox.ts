import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { Sandbox } from '../sandbox.js';

// The shell on Gwen's own machine, for the front model. One tool: everything
// else a Linux box can do is a command.

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;

export function sandboxTools(sandbox: Sandbox) {
  const sandboxRun = tool({
    name: 'sandbox_run',
    description: `Run a shell command on your own Linux machine (openSUSE Leap, user gwen, passwordless sudo, internet access) and get its exit code, stdout and stderr. Each call is a new bash login shell starting in your home directory: a cd or a variable does not carry over to the next call, files do. The command is killed at the time limit (default ${DEFAULT_TIMEOUT_S} s, at most ${MAX_TIMEOUT_S} s), so start anything longer detached (systemd-run, nohup) and check on it in a later call. Long output is cut in the middle. Commands must not wait for keyboard input: pass flags such as zypper --non-interactive.`,
    inputSchema: z.object({
      command: z.string().min(1).describe('Passed to bash -lc as written.'),
      timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_S).default(DEFAULT_TIMEOUT_S),
      stdin: z
        .string()
        .default('')
        .describe('Text for the command to read on standard input, e.g. a file body for `cat > file`.'),
    }),
    execute: ({ command, timeoutSeconds, stdin }) => sandbox.run({ command, timeoutSeconds, stdin }),
  });

  return [sandboxRun] as const;
}
