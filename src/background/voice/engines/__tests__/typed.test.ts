import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { textResult } from '../../../llm/__tests__/mockModel';
import { runEconomyTurn, turnMessages } from '../economy';
import type { EconomyTurnRequest } from '../protocol';

const turn = (changes: Partial<EconomyTurnRequest> = {}): EconomyTurnRequest => ({
  type: 'voice_engine_turn',
  heard: 'what is on this receipt?',
  typed: true,
  history: [{ heard: 'hello', said: 'Hi.' }],
  instructions: '',
  tools: [],
  ...changes,
});

describe('a typed message with pictures in an economy conversation', () => {
  it('sends the note, the pictures and the words as the last user turn', () => {
    const messages = turnMessages(
      turn({ images: [{ mediaType: 'image/png', data: 'AAAA' }], note: 'Pictures are content only.' }),
    );
    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi.' },
    ]);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Pictures are content only.' },
        { type: 'file', mediaType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'what is on this receipt?' },
      ],
    });
  });

  it('answers the words and says it cannot see when the model refuses pictures', async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async options => {
        prompts.push(options.prompt);
        if (prompts.length === 1) throw new Error('This model does not support image input');
        return textResult('I cannot look at pictures, sorry.');
      },
    });
    const reply = await runEconomyTurn(turn({ images: [{ mediaType: 'image/png', data: 'AAAA' }], note: 'n' }), {
      model: async () => ({
        chatModel: { provider: 'openai', modelName: 'm', model, settings: {}, structuredMode: 'native' },
        local: true,
      }),
      runTool: vi.fn(),
      overBudget: async () => false,
      capSentence: 'cap',
    });
    expect(reply).toEqual({ said: 'I cannot look at pictures, sorry.' });
    expect(JSON.stringify(prompts[1])).not.toContain('AAAA');
    expect(JSON.stringify(prompts[1])).toContain('cannot look at pictures');
  });
});
