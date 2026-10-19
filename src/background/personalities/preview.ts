// Preview in the personality and agent editors: says a short line in one voice of one engine, so the user can hear
// the choice before saving it. Only the user's own click in the panel starts it; it never runs during a conversation.
import { z } from 'zod';
import { t } from '@extension/i18n';
import { toAppError } from '@extension/shared';
import { registerCommand } from '../registry';
import { services } from '../registry/services';
import * as chromeEngine from '../tts/chromeEngine';
import * as geminiEngine from '../tts/geminiEngine';
import { speakLocally } from '../voice/engines/localTts';
import { forgetInstalledVoiceModels, installedVoiceModels } from '../voice/engines/models';

export const voicePreviewRequest = z.object({
  type: z.literal('voice_preview'),
  requestId: z.string().optional(),
  // 'live' is a Gemini voice: the same prebuilt voices Live speaks with, heard through Gemini's speech model
  engine: z.enum(['live', 'kitten', 'kokoro', 'system']),
  voice: z.string().max(200),
  rate: z.number().min(0.5).max(2).optional(),
  // Who is speaking, for the sample line ("Hi, I'm Research…")
  name: z.string().max(60).optional(),
});

export type VoicePreviewRequest = z.infer<typeof voicePreviewRequest>;

/** Says the sample line; throws a plain sentence when that voice cannot speak here. */
export async function previewVoice(input: VoicePreviewRequest): Promise<void> {
  if (services().voice.running) throw new Error(t('persona_voice_preview_busy'));
  const name = input.name?.trim() || 'Ava';
  const sentence = t('persona_voice_preview_sentence', [name]);
  const voice = input.voice.trim() || undefined;
  switch (input.engine) {
    case 'live':
      await geminiEngine.speak(sentence, { voice });
      return;
    case 'kitten':
    case 'kokoro': {
      forgetInstalledVoiceModels();
      if (!(await installedVoiceModels())[input.engine]) throw new Error(t('persona_voice_preview_notInstalled'));
      await speakLocally(input.engine, sentence, { voice, rate: input.rate });
      return;
    }
    case 'system':
      await chromeEngine.speak(sentence, { voice, rate: input.rate });
      return;
  }
}

registerCommand('voice_preview', voicePreviewRequest, async (input, context) => {
  try {
    await previewVoice(input);
    context.reply({ type: 'voice_preview_ok', requestId: context.requestId });
  } catch (error) {
    context.reply({ type: 'error', requestId: context.requestId, error: toAppError(error).message });
  }
});
