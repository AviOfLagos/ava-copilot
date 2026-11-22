import {
  effectiveTtsEngine,
  personalityRateOf,
  personalityVoiceFor,
  threadStore,
  threadTts,
  ttsSettingsStore,
  ttsSpeakingStore,
  voiceHealthStore,
} from '@extension/storage';
import { agentSpeaker, personalityForThread, spokenLine } from '../personalities/voices';
import type { Speaker } from '../personalities/voices';
import { services } from '../registry/services';
import * as chromeEngine from './chromeEngine';
import * as geminiEngine from './geminiEngine';
import { missingVoiceFiles } from './missing';
import { toSpeakableText } from './markdown';
import type { SpeakOptions, TtsEngine } from './types';
import { noteSlowFallback, slowVoice } from '../voice/engines/health';
import { localTtsEngine, stopLocalSpeech } from '../voice/engines/localTts';
import { installedVoiceModels } from '../voice/engines/models';

function engineFor(id: string): TtsEngine {
  if (id === 'kitten' || id === 'kokoro') return localTtsEngine(id);
  return id === 'gemini' ? geminiEngine : chromeEngine;
}

// The engine of the line being said: a chat can speak with another engine than Settings
let speakingEngine: string | null = null;

/** Stops whichever engine might be speaking. Safe to call when neither is. */
export async function stopSpeaking(): Promise<void> {
  await Promise.allSettled([chromeEngine.stop(), geminiEngine.stop(), stopLocalSpeech()]);
  await ttsSpeakingStore.set({ threadId: null, messageId: null });
}

/** Whether the chosen engine is speaking right now. */
export async function speaking(): Promise<boolean> {
  if (speakingEngine) return engineFor(speakingEngine).speaking();
  const settings = await ttsSettingsStore.getSettings();
  const installed = await installedVoiceModels().catch(() => null);
  return engineFor(effectiveTtsEngine(settings, installed)).speaking();
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
  const stored = await ttsSettingsStore.getSettings();
  const thread = await threadStore.get(context.threadId).catch(() => undefined);
  const chosen = threadTts(stored, thread?.voice);
  // Until the user picks, a voice on this computer speaks when one is installed (effectiveTtsEngine)
  const installed = await installedVoiceModels().catch(() => null);
  // A voice name from Settings belongs to the engine of Settings
  const settings = {
    ...chosen,
    engine: effectiveTtsEngine(chosen, installed),
    voice: chosen.engine === stored.engine ? stored.voice : '',
  };
  const said = toSpeakableText(text);
  await stopSpeaking();
  if (!said) return;

  // A voice on this computer that makes speech slower than it plays leaves a pause after every sentence: the computer's
  // own voice speaks instead, and the Inbox says so (voice/engines/health.ts)
  const slow = slowVoice(settings.engine, await voiceHealthStore.getHealth(), said.length);
  if (slow) {
    settings.engine = 'system';
    settings.voice = '';
    void noteSlowFallback(slow);
  }

  // The chat's personality (an agent's chat: the agent's) may ask for its own voice and pace
  const personality = await personalityForThread(thread).catch(() => null);
  const speaker = context.speaker ?? (await agentSpeaker(thread?.agentId).catch(() => null));
  const spoken = context.speaker ? spokenLine(context.speaker, said) : said;
  await ttsSpeakingStore.set({ threadId: context.threadId, messageId: context.messageId });
  const voiceOptions = (engine: string): SpeakOptions => ({
    voice:
      personalityVoiceFor(engine, speaker ?? personality) ??
      (engine === settings.engine ? settings.voice || undefined : undefined),
    rate: speaker?.rate ?? personalityRateOf(personality) ?? settings.rate,
    ...options,
  });
  speakingEngine = settings.engine;
  try {
    try {
      await engineFor(settings.engine).speak(spoken, voiceOptions(settings.engine));
    } catch (error) {
      // An on-device voice whose files are not downloaded (or failed to load): the answer is still said, with the
      // computer's own voice, and Settings › Voice offers the download
      if ((settings.engine !== 'kitten' && settings.engine !== 'kokoro') || !missingVoiceFiles(error)) throw error;
      await chromeEngine.speak(spoken, voiceOptions('system'));
    }
  } finally {
    speakingEngine = null;
    await ttsSpeakingStore.set({ threadId: null, messageId: null });
  }
}
