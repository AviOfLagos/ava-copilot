import { describe, expect, it, vi } from 'vitest';
import { enT } from '@src/background/skills/__tests__/en';
import { systemMessage, userMessage } from '@src/background/llm/messages';
import { mockChatModel, textResult } from '@src/background/llm/__tests__/mockModel';
import type { AgentContext } from '../../types';
import type { BasePrompt } from '../../prompts/base';
import { isEmptyAnswer, PlannerAgent } from '../planner';

vi.mock('@extension/i18n', () => ({ t: enT }));

const reply = (fields: { done: boolean; final_answer: string; next_steps?: string }) =>
  textResult(
    JSON.stringify({
      observation: '',
      challenges: '',
      reasoning: '',
      next_steps: '',
      web_task: false,
      ...fields,
    }),
  );

function plannerWith(replies: ReturnType<typeof textResult>[]) {
  const { chatModel, model } = mockChatModel(replies);
  const events: { state: string; details: string }[] = [];
  const context = {
    controller: new AbortController(),
    options: { useVision: false, useVisionForPlanner: false },
    messageManager: { getMessages: () => [systemMessage('navigator'), userMessage('Hi')] },
    emitEvent: (_actor: string, state: string, details: string) => events.push({ state, details }),
  } as unknown as AgentContext;
  const prompt = { getSystemMessage: () => systemMessage('planner') } as unknown as BasePrompt;
  return { planner: new PlannerAgent({ chatLLM: chatModel, context, prompt }), model, events };
}

describe('isEmptyAnswer', () => {
  it('reads empty answers and the placeholders models write for nothing', () => {
    for (const text of ['', '  ', 'None', 'none.', '"None"', 'null', 'NULL', 'undefined', 'N/A', '**None**'])
      expect(isEmptyAnswer(text), text).toBe(true);
  });

  it('keeps real answers, even short ones or ones that start with None', () => {
    for (const text of ['Hi!', 'No', 'None of your meetings moved.', 'Nothing new today.', '0'])
      expect(isEmptyAnswer(text), text).toBe(false);
  });
});

describe('PlannerAgent final answer', () => {
  it('asks again once when the model finishes with "None", and shows the second answer', async () => {
    const { planner, model, events } = plannerWith([
      reply({ done: true, final_answer: 'None' }),
      reply({ done: true, final_answer: 'Hi Avi! What can I do for you?' }),
    ]);
    const output = await planner.execute();
    expect(output.result?.final_answer).toBe('Hi Avi! What can I do for you?');
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('placeholder such as \\"None\\"');
    expect(events.at(-1)).toEqual({ state: 'step.ok', details: 'Hi Avi! What can I do for you?' });
  });

  it('never shows "None": a second empty answer becomes a plain "say it again"', async () => {
    const { planner, events } = plannerWith([
      reply({ done: true, final_answer: 'None' }),
      reply({ done: true, final_answer: 'null' }),
    ]);
    const output = await planner.execute();
    expect(output.result?.final_answer).toBe(enT('exec_emptyAnswer'));
    expect(events.at(-1)?.details).toBe(enT('exec_emptyAnswer'));
    expect(enT('exec_emptyAnswer')).not.toBe('exec_emptyAnswer');
  });

  it('takes a plan from the second call when the model turns it into a web task', async () => {
    const { planner } = plannerWith([
      reply({ done: true, final_answer: '' }),
      reply({ done: false, final_answer: '', next_steps: '1. Open the calendar.' }),
    ]);
    const output = await planner.execute();
    expect(output.result).toMatchObject({ done: false, next_steps: '1. Open the calendar.' });
  });

  it('asks only once and leaves a real answer as it is', async () => {
    const { planner, model } = plannerWith([reply({ done: true, final_answer: 'Two meetings today.' })]);
    expect((await planner.execute()).result?.final_answer).toBe('Two meetings today.');
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
