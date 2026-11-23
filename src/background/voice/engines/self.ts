import { agentModelStore, AgentNameEnum, llmProviderStore, voiceLanguageName } from '@extension/storage';
import type { EconomyModelRole, RoleTarget } from '@extension/storage';
import { resolveRole } from '../../models/roles';
import type { EconomyEngines } from './wire';

/**
 * What a voice conversation knows about itself: which model answers, which engine runs it, who hears and in which
 * language. Built from the settings in force when it starts, never written into the prompt by hand, so "what model
 * are you?" gets a true answer.
 */

export interface VoiceSelf {
  engine: 'live' | 'economy';
  // The model that answers; null when none could be found
  model: { provider: string; model: string } | null;
  // The local recogniser in economy mode; Live hears the audio itself
  recogniser: EconomyEngines['stt'] | null;
  // The user's language from Settings › Voice and language (BCP-47)
  language: string;
  // Whether the Live transcript is told the user's language
  liveLanguageHint?: boolean;
}

const RECOGNISERS: Record<EconomyEngines['stt']['engine'], string> = {
  whisper: 'Whisper',
  moonshine: 'Moonshine',
  vosk: 'Vosk',
};

/** The language a recogniser listens for, as a name; English for the recognisers that only know English. */
function hearingLanguage(self: VoiceSelf): string {
  if (self.engine === 'live') {
    return self.liveLanguageHint === false
      ? 'detected by Gemini Live'
      : `${voiceLanguageName(self.language)} (${self.language})`;
  }
  const stt = self.recogniser;
  if (stt?.engine === 'whisper') return stt.language ? stt.language : 'detected by Whisper';
  return 'English only';
}

/** The "About you right now" section of the voice instructions. */
export function aboutYouSection(self: VoiceSelf): string {
  const model = self.model ? `${self.model.model} (provider: ${self.model.provider})` : 'not set up';
  const engine =
    self.engine === 'live'
      ? 'Gemini Live: it hears the audio, answers and speaks in one model'
      : 'economy: speech is recognised on this computer, a text model answers, and a voice on this computer speaks';
  const recogniser =
    self.engine === 'live'
      ? 'Gemini Live itself'
      : self.recogniser
        ? `${RECOGNISERS[self.recogniser.engine]}, on this computer`
        : 'none installed';
  return `About you right now (true for this conversation; say it when asked what model or engine you run on):
- Model answering: ${model}
- Voice engine: ${engine}
- Speech recogniser: ${recogniser}
- Hearing language: ${hearingLanguage(self)}
- The user's chosen language: ${voiceLanguageName(self.language)} (${self.language})
If you suspect a problem (you cannot hear well, answers fail or are slow, the user says something is wrong), diagnose yourself: call check_audio for the mic and speaker, check_model for the models, then say what you found.`;
}

/** The model the chats answer with: the Navigator's, as set in Settings. */
export async function chatModelTarget(): Promise<RoleTarget | null> {
  const navigator = await agentModelStore.getAgentModel(AgentNameEnum.Navigator).catch(() => null);
  return navigator ? { providerId: navigator.provider, model: navigator.modelName } : null;
}

/** The model an economy conversation answers with, as the provider's display name and the model; null when none. */
export async function economyModelOf(role: EconomyModelRole): Promise<VoiceSelf['model']> {
  const choice =
    role === 'chat'
      ? await resolveRole('fast', { explicit: await chatModelTarget() }).catch(() => null)
      : await resolveRole(role).catch(() => null);
  if (!choice) return null;
  return { provider: await providerName(choice.providerId), model: choice.model };
}

/** A provider's display name, or its id. */
export async function providerName(providerId: string): Promise<string> {
  const summaries = await llmProviderStore
    .getProviderSummaries()
    .catch(() => ({}) as Record<string, { name?: string }>);
  return summaries[providerId]?.name || providerId;
}
