/**
 * Eval: does a real model, given the planner's real prompt for a WhatsApp chat, answer "what can you do?" and
 * "can you reply with a voice note?" truthfully and briefly, and never with "None"? Needs a model, so it is
 * skipped unless one is named:
 *
 *   AVA_EVAL_OLLAMA_MODEL=qwen3:4b pnpm vitest run answer-fit.eval
 *
 * AVA_EVAL_TIMEOUT_MS raises the 5-minute limit per question (a 4B thinking model can take longer).
 * AVA_EVAL_BASELINE=1 runs the same questions without the channel and abilities sections, to compare.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderTypeEnum } from '@extension/storage';
import { enT } from '@src/background/skills/__tests__/en';
import { createChatModel } from '@src/background/llm/providers';
import { currentCapabilities } from '@src/background/capabilities/sources';
import { COMING } from '@src/background/capabilities/coming';
import MessageManager from '../../messages/service';
import type { AgentContext } from '../../types';
import { buildAbilitiesSection, buildChannelSection } from '../../prompts/channel';
import { PlannerPrompt } from '../../prompts/planner';
import { NavigatorPrompt } from '../../prompts/navigator';
import { isEmptyAnswer, PlannerAgent } from '../planner';

vi.mock('@extension/i18n', () => ({ t: enT }));

const MODEL = process.env.AVA_EVAL_OLLAMA_MODEL;

// Every registration loads as at startup, so the abilities are the ones the extension sends; Chrome is a stub that
// answers every call with nothing
const chromeStub: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : chromeStub),
  apply: () => Promise.resolve(undefined),
});
const BASELINE = process.env.AVA_EVAL_BASELINE === '1';

async function answer(task: string): Promise<string> {
  const chatLLM = createChatModel(
    { type: ProviderTypeEnum.Ollama, apiKey: 'ollama', baseUrl: process.env.AVA_EVAL_OLLAMA_URL },
    { provider: ProviderTypeEnum.Ollama, modelName: MODEL! },
  );
  const channel = BASELINE ? '' : buildChannelSection('whatsapp');
  const abilities = BASELINE ? '' : buildAbilitiesSection(currentCapabilities(), COMING);
  const messageManager = new MessageManager();
  messageManager.initTaskMessages(
    new NavigatorPrompt(10, '', 'Ava', null, undefined, channel).getSystemMessage(),
    task,
  );
  const context = {
    controller: new AbortController(),
    options: { useVision: false, useVisionForPlanner: false },
    messageManager,
    emitEvent: () => {},
  } as unknown as AgentContext;
  const prompt = new PlannerPrompt('', 'Ava', null, undefined, `${channel}${abilities}`);
  const output = await new PlannerAgent({ chatLLM, context, prompt }).execute();
  if (output.error) throw new Error(output.error);
  const text = output.result!.final_answer;
  console.log(`\n[${BASELINE ? 'baseline' : 'fixed'}] ${task}\n→ ${text}\n`);
  return text;
}

const SAYS_TEXT_ONLY = /text(-based)? (browser )?interface|only (a )?text|just a text/i;

describe.skipIf(!MODEL)(
  `eval: answers on WhatsApp (${MODEL})`,
  { timeout: Number(process.env.AVA_EVAL_TIMEOUT_MS) || 300_000 },
  () => {
    beforeAll(async () => {
      vi.stubGlobal('chrome', chromeStub);
      await import('@src/background/registers');
    });

    it('"Hi" gets a greeting, never "None"', async () => {
      const text = await answer('Hi');
      expect(isEmptyAnswer(text)).toBe(false);
      expect(text).not.toBe(enT('exec_emptyAnswer'));
    });

    it('"what can you do?" names real abilities, briefly', async () => {
      const text = await answer('what can you do?');
      const named = ['calendar', 'meeting', 'whatsapp', 'memor', 'routine', 'workflow', 'agent', 'tab', 'voice', 'web'];
      expect(named.filter(word => text.toLowerCase().includes(word)).length).toBeGreaterThanOrEqual(3);
      expect(text).not.toMatch(SAYS_TEXT_ONLY);
      expect(text.length).toBeLessThan(1200);
    });

    it('"can you reply with voicenote?" says not yet, it is coming', async () => {
      const text = await answer('can you reply with voicenote?');
      expect(text).toMatch(/not yet|coming|soon|being built/i);
      expect(text).not.toMatch(SAYS_TEXT_ONLY);
    });
  },
);
