import { generateText, hasToolCall, stepCountIs } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import { toAppError } from '@extension/shared';
import type { ChatModel } from '../../llm/types';
import { createLogger } from '../../log';
import { toSpeakableText } from '../../tts/markdown';
import type { EconomyTurnReply, EconomyTurnRequest } from './protocol';
import { voiceToolSet } from './tools';

/**
 * The thinking half of an economy conversation: the words a local recogniser heard go to a text model (chosen by
 * role: the quick model, or one running on this Mac) with the same voice tools as the Live session, and its answer
 * comes back as plain sentences for the local voice. Audio never reaches a model; a local model costs nothing.
 */

const logger = createLogger('VoiceEconomy');

export const END_CONVERSATION = 'end_conversation';
// Model calls in one turn: a tool or two, then the answer
// How long the model may take for one voice turn, tools included
const MODEL_LIMIT_MS = 110_000;
const MAX_STEPS = 5;
const MAX_SAID = 1500;

export const ECONOMY_INSTRUCTIONS = `Your replies are read aloud by a small voice on the user's own computer, and what the user says reaches you through on-device speech recognition.
Answer in plain spoken sentences: no markdown, no lists, no emoji, no links. Keep it to one or two short sentences unless the user asks for more.
The recognised words may have mistakes; if you are not sure what was meant, ask one short question.
When the user says goodbye or asks to end the conversation, call end_conversation and say nothing else.`;

export interface EconomyBrainDeps {
  // The text model for this turn, and whether it runs on this Mac (free, so no budget applies)
  model: () => Promise<{ chatModel: ChatModel; local: boolean }>;
  // Runs a voice tool through the voice manager (its guard and its handlers)
  runTool: (name: string, args: Record<string, unknown>, heard: string) => Promise<string>;
  overBudget: () => Promise<boolean>;
  // Said when the daily cap stops the conversation
  capSentence: string;
}

const noticeText = (notice: string) => `System notice. Tell the user, in one short sentence: ${notice}`;

/** The conversation so far and this turn, as chat messages; turns of one role in a row are joined. */
export function turnMessages(request: EconomyTurnRequest): ModelMessage[] {
  const raw: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const item of request.history) {
    const heard = item.notice ? noticeText(item.heard) : item.heard;
    if (heard.trim()) raw.push({ role: 'user', text: heard });
    if (item.said.trim()) raw.push({ role: 'assistant', text: item.said });
  }
  raw.push({ role: 'user', text: request.notice ? noticeText(request.notice) : (request.heard ?? '') });
  const merged: typeof raw = [];
  for (const message of raw) {
    const last = merged[merged.length - 1];
    if (last?.role === message.role) last.text = `${last.text}\n${message.text}`;
    else merged.push({ ...message });
  }
  // A conversation starts with the user
  while (merged[0]?.role === 'assistant') merged.shift();
  const messages: ModelMessage[] = merged.map(message => ({ role: message.role, content: message.text }));
  // Pictures typed into the chat go with this turn, after the note that they are content only
  const last = messages[messages.length - 1];
  if (request.images?.length && last?.role === 'user' && typeof last.content === 'string') {
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        ...(request.note ? [{ type: 'text' as const, text: request.note }] : []),
        ...request.images.map(image => ({ type: 'file' as const, mediaType: image.mediaType, data: image.data })),
        { type: 'text' as const, text: last.content },
      ],
    };
  }
  return messages;
}

/**
 * Said when the model refuses tools. Answering without them would make it claim, truthfully for itself, that it
 * cannot reach the user's chats, memory or notes (issue #34): so the reason is said, never a quiet retry with none.
 */
export const TOOLS_REFUSED_SENTENCE =
  "The voice model you're using can't use my tools, so I can't look in your chats, memory or notes right now. " +
  'Pick a different voice model in Models and usage, and ask me again.';

const CANNOT_SEE =
  '(The user attached pictures, but this voice model cannot look at pictures. Say so in one short sentence.)';

/** Whether a provider refused because the model cannot use tools (some local models). */
function toolsRefused(error: unknown): boolean {
  return /tool|function call/i.test(String((error as { message?: string })?.message ?? error));
}

/** One turn: the model answers, calling voice tools as it needs, and the answer is made speakable. */
export async function runEconomyTurn(request: EconomyTurnRequest, deps: EconomyBrainDeps): Promise<EconomyTurnReply> {
  let ended = false;
  let toolRuns = 0;
  try {
    const { chatModel, local } = await deps.model();
    if (!local && (await deps.overBudget())) return { said: deps.capSentence, ended: true };
    const heard = request.heard ?? '';
    const tools: ToolSet = voiceToolSet(request.tools, async (name, args) => {
      toolRuns++;
      if (name === END_CONVERSATION) ended = true;
      return deps.runTool(name, args, heard);
    });
    // A model that cannot see answers the words, and says it cannot see the pictures
    let turn = request;
    const call = (withTools: boolean) =>
      generateText({
        model: chatModel.model,
        instructions: [ECONOMY_INSTRUCTIONS, request.instructions].filter(Boolean).join('\n\n'),
        messages: turnMessages(turn),
        ...(withTools ? { tools, stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(END_CONVERSATION)] } : {}),
        maxRetries: 1,
        // The conversation gives up on a turn at 120 s (offscreen/stt/economy.ts); the model call stops first
        abortSignal: AbortSignal.timeout(MODEL_LIMIT_MS),
        ...chatModel.settings,
        providerOptions: chatModel.providerOptions,
      });
    let result: Awaited<ReturnType<typeof call>>;
    try {
      try {
        result = await call(true);
      } catch (error) {
        if (!request.images?.length || toolRuns > 0) throw error;
        turn = { ...request, images: undefined, note: undefined, heard: `${request.heard ?? ''}\n${CANNOT_SEE}` };
        result = await call(true);
      }
    } catch (error) {
      // A model that cannot use tools is not asked again without them: it would then say it has no access to the
      // user's chats, memory or notes. The reason is said instead. Never after a tool ran: no answer without it
      if (!toolsRefused(error) || toolRuns > 0) throw error;
      logger.warning(`The voice model ${chatModel.provider}/${chatModel.modelName} refused the voice tools`);
      return { said: TOOLS_REFUSED_SENTENCE };
    }
    logger.debug(`Voice turn answered by ${chatModel.provider}/${chatModel.modelName}`);
    if (ended) return { said: '', ended: true };
    return { said: toSpeakableText(result.text ?? '').slice(0, MAX_SAID) };
  } catch (error) {
    if (ended) return { said: '', ended: true };
    return { said: '', error: toAppError(error, 'The text model did not answer.').message };
  }
}
