import type { AnsweredTask } from './gatekeeper.js';
import { log } from './log.js';

export const EXPLAINER_MODEL = 'claude-opus-5-5';

/** What the explainer is told about one answered Task. */
export type ExplainFacts = AnsweredTask;

/** Plain-language account of a Decision, or null when none could be made. Never throws. */
export type Explainer = (facts: ExplainFacts) => Promise<string | null>;

/** The slice of the Anthropic SDK we use: `client.beta.messages`. */
export interface MessagesApi {
  create(params: never, options?: never): Promise<unknown>;
}

const EXPLAINER_SYSTEM_PROMPT = [
  'You explain decisions made by an automated payment approver in the zkVerify Agent Games "Proof Gatekeeper" event.',
  'Each task describes a payment whose attached proof reference verifies; the approver approves only when every field agrees, and rejects on the first failing check.',
  'The decision and reason code you are given are final and were made by deterministic code. Explain them; never second-guess them.',
  'Write 2-3 plain sentences for a public audience. Name the specific fields and values that decided it. No preamble, no markdown.',
].join(' ');

export function createClaudeExplainer(messages: MessagesApi, timeoutMs = 20_000): Explainer {
  return async (facts) => {
    try {
      const params = {
        model: EXPLAINER_MODEL,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: EXPLAINER_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Decision: ${facts.decision}\nReason code: ${facts.reasonCode}\nTask input:\n${JSON.stringify(facts.input, null, 2)}`,
          },
        ],
      };
      const res = (await messages.create(params as never, { timeout: timeoutMs, maxRetries: 0 } as never)) as {
        stop_reason?: string;
        content?: { type: string; text?: string }[];
      };
      if (res.stop_reason === 'refusal') {
        log('explain.refused', { taskId: facts.taskId });
        return null;
      }
      const text = (res.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      return text === '' ? null : text;
    } catch (e) {
      log('explain.failed', { taskId: facts.taskId, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
}
