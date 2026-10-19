import {
  personalityRateOf,
  personalityVoiceFor,
  threadStore,
  ttsSettingsStore,
  ttsSpeakingStore,
} from '@extension/storage';
import { agentSpeaker, personalityForThread, spokenLine } from '../personalities/voices';
import type { Speaker } from '../personalities/voices';
import { services } from '../registry/services';
import * as chromeEngine from './chromeEngine';
import * as geminiEngine from './geminiEngine';
import { toSpeakableText } from './markdown';
import type { SpeakOptions, TtsEngine } from './types';
import { localTtsEngine, stopLocalSpeech } from '../voice/engines/localTts';

function engineFor(id: string): TtsEngine {
  if (id === 'kitten' || id === 'kokoro') return localTtsEngine(id);
  return id === 'gemini' ? geminiEngine : chromeEngine;
}

/** Stops whichever engine might be speaking. Safe to call when neither is. */
export async function stopSpeaking(): Promise<void> {
  await Promise.allSettled([chromeEngine.stop(), geminiEngine.stop(), stopLocalSpeech()]);
  await ttsSpeakingStore.set({ threadId: null, messageId: null });
}

/** Whether the chosen engine is speaking right now. */
export async function speaking(): Promise<boolean> {
  const settings = await ttsSettingsStore.getSettings();
  return engineFor(settings.engine).speaking();
}

/**
 * Reads an answer aloud: markdown becomes words, whatever was speaking stops first (one speaker at a
 * time), and the chosen engine takes it from there. Never speaks while the Gemini Live conversation is
 * going - it announces things itself, and two voices at once would only confuse things.
 */
export async function speak(
  text: string,
  // `speaker`: someone other than the chat's own voice says it (an agent's line), its name first
  context: { threadId: string; messageId: string; speaker?: Speaker | null },
  options: SpeakOptions = {},
): Promise<void> {
  if (services().voice.running) return;
  const settings = await ttsSettingsStore.getSettings();
  const said = toSpeakableText(text);
  await stopSpeaking();
  if (!said) return;

  // The chat's personality (an agent's chat: the agent's) may ask for its own voice and pace
  const thread = await threadStore.get(context.threadId).catch(() => undefined);
  const personality = await personalityForThread(thread).catch(() => null);
  const speaker = context.speaker ?? (await agentSpeaker(thread?.agentId).catch(() => null));
  const spoken = context.speaker ? spokenLine(context.speaker, said) : said;
  await ttsSpeakingStore.set({ threadId: context.threadId, messageId: context.messageId });
  try {
    await engineFor(settings.engine).speak(spoken, {
      voice: personalityVoiceFor(settings.engine, speaker ?? personality) ?? (settings.voice || undefined),
      rate: speaker?.rate ?? personalityRateOf(personality) ?? settings.rate,
      ...options,
    });
  } finally {
    await ttsSpeakingStore.set({ threadId: null, messageId: null });
  }
}
