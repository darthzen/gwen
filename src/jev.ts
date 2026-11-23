import { z } from 'zod';
import type { JevConfig } from './config.js';
import { requestJson } from './http.js';
import { OPENROUTER_API } from './openrouter.js';
import { log, errText } from './log.js';

// Jev through OpenRouter's Decisions API. Rick's standing rule is that
// decisions go through Jev, with an outage as the only permitted skip. Gwen's
// one real decision per message is how to handle it, so that is what is asked.
// The API is alpha: any failure, refusal or unexpected shape yields no route
// and the turn proceeds without one, saying so in the log.

/**
 * The ways Gwen can handle a message. Each route is defined once: `criteria`
 * is what Jev judges against, `hint` is what the front model is told when Jev
 * picks it. Adding a route means adding one entry here.
 */
export const ROUTES = {
  direct: {
    criteria:
      'Answer now in one reply: conversation, a question answerable from memory or general knowledge, a request to remember something, a fact one quick web lookup settles, or a task a few commands on her own Linux machine settle.',
    hint: 'answer directly in this reply.',
  },
  research: {
    criteria:
      'Needs background research: comparing options, surveying a topic, anything that needs several sources read and synthesised, or work the user explicitly asks to be researched or looked into in depth.',
    hint: 'background research. Call start_research with a self-contained question, then tell the user in one line that it is running.',
  },
  clarify: {
    criteria:
      "Too ambiguous to act on: the message could mean materially different things and guessing would waste the user's time.",
    hint: 'ambiguous. Ask one short clarifying question instead of guessing.',
  },
} as const;

export type Route = keyof typeof ROUTES;

/** Below this probability Jev's pick is treated as no pick. */
const MIN_CONFIDENCE = 0.6;

export interface Routing {
  /** The route to act on: Jev's pick when it was confident enough, else null. */
  route: Route | null;
  /** Jev's pick whatever its confidence, kept for the turn log. */
  picked: Route | null;
  confidence: number;
  ms: number;
  error?: string;
}

const DecisionResponse = z.object({
  answers: z.object({
    route: z.object({
      type: z.literal('choice'),
      choice: z.enum(Object.keys(ROUTES) as [Route, ...Route[]]),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
    }),
  }),
});

export async function routeMessage(
  cfg: JevConfig,
  apiKey: string,
  message: string,
  recentConversation: string,
): Promise<Routing> {
  const started = Date.now();
  try {
    const { answers } = await requestJson({
      service: 'jev',
      url: `${OPENROUTER_API}/alpha/decisions`,
      bearer: apiKey,
      timeoutMs: cfg.timeoutMs,
      schema: DecisionResponse,
      body: {
        model: cfg.model,
        state: { message, recent_conversation: recentConversation },
        questions: {
          route: {
            type: 'choice',
            instructions: 'How should a personal concierge assistant handle `message`, given `recent_conversation`?',
            criteria: Object.fromEntries(Object.entries(ROUTES).map(([name, r]) => [name, r.criteria])),
          },
        },
      },
    });
    const { choice, probabilities, confidence: stated } = answers.route;
    const confidence = probabilities?.[choice] ?? stated ?? 0;
    return { route: confidence >= MIN_CONFIDENCE ? choice : null, picked: choice, confidence, ms: Date.now() - started };
  } catch (e) {
    log.warn('jev unavailable', { error: errText(e) });
    return { route: null, picked: null, confidence: 0, ms: Date.now() - started, error: errText(e) };
  }
}
