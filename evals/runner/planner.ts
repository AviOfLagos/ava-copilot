import { expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { ProviderTypeEnum } from '@extension/storage';
import { createChatModel } from '@src/background/llm/providers';
import type { ChatModel } from '@src/background/llm/types';
import { currentCapabilities } from '@src/background/capabilities/sources';
import { COMING } from '@src/background/capabilities/coming';
import MessageManager from '@src/background/agent/messages/service';
import type { AgentContext } from '@src/background/agent/types';
import { buildAbilitiesSection, buildChannelSection } from '@src/background/agent/prompts/channel';
import { PlannerPrompt } from '@src/background/agent/prompts/planner';
import { NavigatorPrompt } from '@src/background/agent/prompts/navigator';
import { PlannerAgent } from '@src/background/agent/agents/planner';
import type { PlannerCase } from './cases';

/** The model the planner cases run against instead of their recorded replies, when one is named. */
export const LIVE_MODEL = process.env.AVA_EVAL_OLLAMA_MODEL;

/** The planner's JSON reply for a recorded reply: as it is when it is one, else a finished answer saying it. */
function plannerReply(recorded: string): string {
  try {
    const parsed: unknown = JSON.parse(recorded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return recorded;
  } catch {
    // A plain answer
  }
  return JSON.stringify({
    observation: '',
    challenges: '',
    done: true,
    next_steps: '',
    final_answer: recorded,
    reasoning: '',
    web_task: false,
  });
}

/** A model that says the recorded replies in order, then the last one again for every further call. */
function replayModel(recorded: string[]): ChatModel {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const text = plannerReply(recorded[Math.min(call++, recorded.length - 1)]);
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { provider: 'openai', modelName: 'replay', model, settings: {}, structuredMode: 'native' };
}

function liveModel(): ChatModel {
  return createChatModel(
    { type: ProviderTypeEnum.Ollama, apiKey: 'ollama', baseUrl: process.env.AVA_EVAL_OLLAMA_URL },
    { provider: ProviderTypeEnum.Ollama, modelName: LIVE_MODEL! },
  );
}

/** The planner's answer to the case's message, with the system prompt it was given, as in a real chat. */
export async function plannerAnswer(evalCase: PlannerCase): Promise<{ answer: string; prompt: string }> {
  const channel = buildChannelSection(evalCase.channel);
  const abilities = buildAbilitiesSection(currentCapabilities(), COMING);
  const messageManager = new MessageManager();
  messageManager.initTaskMessages(
    new NavigatorPrompt(10, '', 'Ava', null, undefined, channel).getSystemMessage(),
    evalCase.input,
  );
  const context = {
    controller: new AbortController(),
    options: { useVision: false, useVisionForPlanner: false },
    messageManager,
    emitEvent: () => {},
  } as unknown as AgentContext;
  const prompt = new PlannerPrompt('', 'Ava', null, undefined, `${channel}${abilities}`);
  if (!LIVE_MODEL && !evalCase.replay) throw new Error('The case has no recorded replies and no live model is set');
  const chatLLM = LIVE_MODEL ? liveModel() : replayModel(evalCase.replay!.planner);
  const output = await new PlannerAgent({ chatLLM, context, prompt }).execute();
  if (output.error) throw new Error(output.error);
  return { answer: output.result?.final_answer ?? '', prompt: prompt.getSystemMessage().content };
}

const pattern = (source: string) => new RegExp(source, 'i');

// The eval's own idea of an answer with nothing in it, not the planner's: a case must fail on code without the guard
const PLACEHOLDER = /^(?:none|null|nil|undefined|n\/?a|empty|no answer)?$/i;
const isEmptyAnswer = (text: string) => PLACEHOLDER.test(text.trim().replace(/^["'`*_\s]+|["'`*_.!\s]+$/g, ''));

export async function runPlannerCase(evalCase: PlannerCase): Promise<void> {
  const { answer, prompt } = await plannerAnswer(evalCase);
  const checks = [evalCase.expect, ...(LIVE_MODEL && evalCase.live ? [evalCase.live] : [])];
  for (const want of checks) {
    if (want.answer_not_empty) expect(isEmptyAnswer(answer), `answer is empty: "${answer}"`).toBe(false);
    for (const bad of want.answer_not ?? [])
      expect(answer.trim().toLowerCase(), 'the user got the failing answer again').not.toBe(bad.trim().toLowerCase());
    for (const source of want.answer_matches ?? []) expect(answer).toMatch(pattern(source));
    for (const source of want.answer_not_matches ?? []) expect(answer).not.toMatch(pattern(source));
    for (const source of want.prompt_matches ?? []) expect(prompt, 'planner prompt').toMatch(pattern(source));
    for (const source of want.prompt_not_matches ?? []) expect(prompt, 'planner prompt').not.toMatch(pattern(source));
  }
}
