import { describe, expect, it } from 'vitest';
import { createClaudeExplainer, type ExplainFacts } from '../src/explainer.js';
import { rawInput } from './fixtures.js';

const facts: ExplainFacts = {
  taskId: 'gk_1',
  decision: 'REJECT',
  reasonCode: 'VK_SUBSTITUTION',
  input: rawInput({ proof_vk: '0x13aa' }),
};

function fakeMessages(reply: () => Promise<unknown>) {
  const calls: { params: Record<string, unknown>; options: unknown }[] = [];
  return {
    calls,
    create: (params: Record<string, unknown>, options?: unknown) => {
      calls.push({ params, options });
      return reply();
    },
  };
}

describe('Claude explainer', () => {
  it('returns the model text for a Decision', async () => {
    const messages = fakeMessages(async () => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Rejected: the proof was made with a different key.' },
      ],
    }));
    const text = await createClaudeExplainer(messages)(facts);
    expect(text).toBe('Rejected: the proof was made with a different key.');
    const { params } = messages.calls[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(JSON.stringify(params.messages)).toContain('VK_SUBSTITUTION');
  });

  it('returns null when the model refuses', async () => {
    const messages = fakeMessages(async () => ({ stop_reason: 'refusal', content: [] }));
    expect(await createClaudeExplainer(messages)(facts)).toBeNull();
  });

  it('returns null instead of throwing when the API fails', async () => {
    const messages = fakeMessages(async () => {
      throw new Error('529 overloaded');
    });
    expect(await createClaudeExplainer(messages)(facts)).toBeNull();
  });
});
