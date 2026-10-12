import { t } from '@extension/i18n';
import { llmProviderStore, ProviderTypeEnum } from '@extension/storage';
import { AppError } from '@extension/shared';
import { ensureOffscreen, toOffscreen } from '../offscreen';
import { synthesizeSpeech } from './gemini';
import { pcmToWavDataUrl } from './wav';
import type { SpeakOptions } from './types';

let pending: { resolve: () => void; reject: (error: unknown) => void } | null = null;

async function geminiApiKey(): Promise<string | null> {
  const providers = await llmProviderStore.getAllProviders();
  const match = Object.values(providers).find(provider => provider.type === ProviderTypeEnum.Gemini && provider.apiKey);
  return match?.apiKey ?? null;
}

/**
 * Engine B, optional: the background fetches audio with the Gemini key (never sent anywhere else),
 * then hands only the resulting bytes to the offscreen document to play. `speak()` resolves only once
 * playback actually ends, the same contract the system-voice engine has, so the caller never has to
 * know which engine is in use.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const apiKey = await geminiApiKey();
  if (!apiKey) {
    throw new AppError('invalid', t('speak_errors_noKey'));
  }
  const { base64, sampleRateHz } = await synthesizeSpeech(apiKey, text, { voice: options.voice || undefined });
  const dataUrl = pcmToWavDataUrl(base64, sampleRateHz);
  await ensureOffscreen();
  await toOffscreen({ type: 'tts_play', audio: dataUrl });
  await new Promise<void>((resolve, reject) => {
    pending = { resolve, reject };
  });
}

export async function stop(): Promise<void> {
  await toOffscreen({ type: 'tts_stop' }).catch(() => {});
  pending?.resolve();
  pending = null;
}

export async function speaking(): Promise<boolean> {
  const result = await toOffscreen<{ running?: boolean }>({ type: 'tts_running' }).catch(() => ({ running: false }));
  return result.running ?? false;
}

/** The offscreen player finished the clip on its own; called from the runtime message listener. */
export function onEnded(): void {
  pending?.resolve();
  pending = null;
}

/** The offscreen player could not play the clip; called from the runtime message listener. */
export function onError(message: string): void {
  pending?.reject(new AppError('unknown', message));
  pending = null;
}
