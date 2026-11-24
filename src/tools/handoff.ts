import { tool } from '@openrouter/agent';
import { z } from 'zod';

/**
 * Offered only in a turn that answers a person while a task is waiting to
 * resume. Continuing is the default; this is how the model stops it.
 */
export function handoffTools(cancel: () => void) {
  const cancelResume = tool({
    name: 'cancel_resume',
    description:
      'Cancel the automatic resume of the task described in the handoff note. Call it when the new message tells you to stop that task or changes what the task is. Without it, the task continues by itself after this turn.',
    inputSchema: z.object({}),
    execute: async () => {
      cancel();
      return { cancelled: true };
    },
  });
  return [cancelResume] as const;
}
