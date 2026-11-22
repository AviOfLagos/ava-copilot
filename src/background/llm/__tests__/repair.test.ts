import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateStructured, repairNote } from '../generate';
import { userMessage } from '../messages';
import { ResponseParseError } from '@src/background/agent/agents/errors';
import { failureBackoffMs } from '@src/background/agent/executor';
import { mockChatModel, textResult, type MockResult } from './mockModel';

const schema = z.object({ answer: z.string() });
const messages = [userMessage('task')];

function malformed(): MockResult {
  return { ...textResult(''), finishReason: { unified: 'other' as const, raw: 'MALFORMED_FUNCTION_CALL' } };
}

describe('self-repair of unusable replies', () => {
  it('asks once more, naming what was wrong, and uses the second reply', async () => {
    const { chatModel, model } = mockChatModel([malformed(), textResult('{"answer":"ok"}')], 'text');
    const { output } = await generateStructured({ chatModel, messages, schema, name: 'x' });
    expect(output).toEqual({ answer: 'ok' });
    expect(model.doGenerateCalls).toHaveLength(2);
    const last = model.doGenerateCalls[1].prompt.at(-1);
    expect(JSON.stringify(last)).toContain('MALFORMED_FUNCTION_CALL');
    expect(JSON.stringify(last)).toContain('do not call any function');
  });

  it('repairs a reply without JSON', async () => {
    const { chatModel, model } = mockChatModel(
      [textResult('Sure, I will click it.'), textResult('{"answer":"ok"}')],
      'text',
    );
    const { output } = await generateStructured({ chatModel, messages, schema, name: 'x' });
    expect(output).toEqual({ answer: 'ok' });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('tries only once and throws the first error when the repair fails too', async () => {
    const { chatModel, model } = mockChatModel([malformed(), textResult('still no json')], 'text');
    await expect(generateStructured({ chatModel, messages, schema, name: 'x' })).rejects.toThrow(
      /MALFORMED_FUNCTION_CALL/,
    );
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('does not repeat a good reply', async () => {
    const { chatModel, model } = mockChatModel([textResult('{"answer":"ok"}')], 'text');
    await generateStructured({ chatModel, messages, schema, name: 'x' });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('asks for a shorter reply after a truncated one', () => {
    const note = repairNote(new ResponseParseError('Could not parse response from g/m: the reply was truncated'));
    expect(note).toContain('the reply was truncated');
    expect(note).toContain('Keep it short');
  });
});

describe('failureBackoffMs', () => {
  it('doubles from 1 s and stops at 8 s', () => {
    expect([1, 2, 3, 4, 5, 10].map(failureBackoffMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
