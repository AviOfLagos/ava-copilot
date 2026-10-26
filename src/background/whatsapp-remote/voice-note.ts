import { AppError } from '@extension/shared';
import { defaultRenderDeps, renderForCall } from '../meet-voice/render';
import type { RenderDeps } from '../meet-voice/render';
import { toVoiceOffscreen } from '../voice/engines/offscreen';

/**
 * Ava's answer as a WhatsApp voice note: said in the voice of the chat's personality by the same engines that speak
 * for her in a call (Kitten or Kokoro on this computer, Gemini as the last resort), then made into Ogg/Opus in the
 * offscreen document, which has WebCodecs. Ava Brain only sends the bytes.
 */

export interface VoiceNoteBytes {
  // Ogg/Opus, base64
  audio: string;
  seconds: number;
  waveform: number[];
}

type Encode = (
  wav: string,
) => Promise<{ ok?: boolean; audio?: string; seconds?: number; waveform?: number[]; error?: string }>;

const encodeOffscreen: Encode = wav => toVoiceOffscreen({ type: 'voice_note_encode', wav });

/** Words already made speakable (no markdown, no emoji) as a voice note. */
export async function voiceNoteOf(
  spoken: string,
  thread: { workspaceId?: string | null; agentId?: string | null } | null,
  deps: { render?: RenderDeps; encode?: Encode } = {},
): Promise<VoiceNoteBytes> {
  const clip = await renderForCall(spoken, deps.render ?? defaultRenderDeps(thread));
  const reply = await (deps.encode ?? encodeOffscreen)(clip.audio);
  if (!reply?.ok || !reply.audio || !reply.seconds || reply.waveform?.length !== 64) {
    throw new AppError('unavailable', reply?.error || 'The voice note could not be made.');
  }
  return { audio: reply.audio, seconds: reply.seconds, waveform: reply.waveform };
}
