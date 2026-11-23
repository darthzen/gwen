import { tool } from '@openrouter/agent';
import { z } from 'zod';
import type { ReplyTarget } from '../adapters/types.js';
import type { Scheduler } from '../schedule.js';

/**
 * Schedule tools for the front model: create, list, and delete scheduled
 * tasks. The target is captured from the conversation the tool is called in.
 */
export function scheduleTools(scheduler: Scheduler, target: ReplyTarget) {
  const scheduleCreate = tool({
    name: 'schedule_create',
    description:
      'Create a scheduled task that fires on a cron schedule and sends a prompt to the current conversation. Minimum interval between fires is 5 minutes.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Short name for the schedule, e.g. "daily briefing".'),
      cron: z
        .string()
        .min(1)
        .describe('5-field cron expression (minute hour day-of-month month day-of-week), in the service timezone.'),
      prompt: z.string().min(1).describe('The prompt to send when the schedule fires.'),
    }),
    execute: async ({ name, cron, prompt }) => {
      const { entry, error } = scheduler.create(name, cron, prompt, target);
      if (error) return { error };
      return { id: entry!.id, name: entry!.name, cron: entry!.cron, createdAt: entry!.createdAt };
    },
  });

  const scheduleList = tool({
    name: 'schedule_list',
    description: 'List all scheduled tasks with their ids, names, cron expressions, and last run times.',
    inputSchema: z.object({}),
    execute: async () => {
      const entries = scheduler.list();
      return {
        schedules: entries.map((e) => ({
          id: e.id,
          name: e.name,
          cron: e.cron,
          createdAt: e.createdAt,
          lastRunAt: e.lastRunAt ?? null,
        })),
      };
    },
  });

  const scheduleDelete = tool({
    name: 'schedule_delete',
    description: 'Delete a scheduled task by its id.',
    inputSchema: z.object({
      id: z.string().min(1).describe('The schedule id, as returned by schedule_create or schedule_list.'),
    }),
    execute: async ({ id }) => {
      const ok = scheduler.delete(id);
      return ok ? { deleted: id } : { error: `no schedule with id ${id}` };
    },
  });

  return [scheduleCreate, scheduleList, scheduleDelete];
}
