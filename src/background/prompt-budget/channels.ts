import { z } from 'zod';
import { buildAbilitiesSection, buildChannelSection } from '../agent/prompts/channel';
import { PlannerPrompt } from '../agent/prompts/planner';
import { navigatorSystemPromptTemplate } from '../agent/prompts/templates/navigator';
import { buildIdentitySection } from '../agent/prompts/style';
import { ActionBuilder, buildDynamicActionSchema } from '../agent/actions/builder';
import type { AgentContext } from '../agent/types';
import { currentCapabilities } from '../capabilities/sources';
import { COMING } from '../capabilities/coming';
import { navigatorGateSection } from '../gate/prompt';
import { navigatorKnowledgeSection } from '../kb/action';
import type { ChatModel } from '../llm/types';
import { navigatorReaderSection } from '../reader/reader';
import { registeredActionPrompts, registeredActions, registeredVoiceTools } from '../registry';
import { VOICE_TOOLS, voiceInstructions } from '../voice/prompt';
import { workspaceSection } from '../workspaces/inject';
import type { Workspace } from '@extension/storage';
import { sizeChannel } from './measure';
import type { ChannelSizes, PromptPart } from './measure';

/**
 * Builds each channel's fixed prompt parts from the real builders and registrations (nothing here is a copy of the
 * text), so the numbers move when the product does. The page state and the conversation are not fixed and are not
 * counted; they are what the usage meter shows.
 */

// A workspace with the longest "about" the app keeps, and one accounts line: the worst case a workspace chat sends
export const SAMPLE_WORKSPACE = {
  id: 'w',
  name: 'Sample workspace',
  about: 'x'.repeat(4000),
  accounts: { google: 'sample@example.com' },
} as unknown as Workspace;

function navigatorTools(): string {
  const stub = {} as AgentContext;
  const actions = [...new ActionBuilder(stub, {} as ChatModel).buildDefaultActions(), ...registeredActions(stub)];
  return JSON.stringify(z.toJSONSchema(buildDynamicActionSchema(actions)));
}

function voiceTools(): string {
  return JSON.stringify([...VOICE_TOOLS, ...registeredVoiceTools().map(tool => tool.declaration)]);
}

function navigatorParts(origin: 'user' | 'whatsapp' | 'agent', workspace: boolean): PromptPart[] {
  const capabilities = currentCapabilities();
  return [
    { name: 'tool definitions', text: navigatorTools() },
    { name: 'rules', text: navigatorSystemPromptTemplate },
    {
      name: 'gate, reader and knowledge rules',
      text: navigatorGateSection + navigatorReaderSection + navigatorKnowledgeSection,
    },
    { name: 'registered action rules', text: registeredActionPrompts() },
    { name: 'identity', text: buildIdentitySection(undefined) },
    { name: 'channel', text: buildChannelSection(origin) },
    { name: 'capability list', text: buildAbilitiesSection(capabilities, COMING) },
    ...(workspace ? [{ name: 'workspace', text: workspaceSection(SAMPLE_WORKSPACE) }] : []),
  ];
}

/** Every channel's parts, sized. */
export function measureChannels(): Record<string, ChannelSizes> {
  const planner = new PlannerPrompt(
    '',
    undefined,
    null,
    undefined,
    buildChannelSection('user') + buildAbilitiesSection(currentCapabilities(), COMING),
  );
  const plannerText = String(planner.getSystemMessage().content);
  return {
    'panel navigator': sizeChannel(navigatorParts('user', false)),
    'panel navigator, in a workspace': sizeChannel(navigatorParts('user', true)),
    'whatsapp navigator': sizeChannel(navigatorParts('whatsapp', false)),
    'agent and routine chats': sizeChannel(navigatorParts('agent', false)),
    'panel planner': sizeChannel([{ name: 'system prompt', text: plannerText }]),
    voice: sizeChannel([
      { name: 'tool definitions', text: voiceTools() },
      { name: 'rules', text: voiceInstructions('Ava') },
    ]),
  };
}
