import { AppError, RETRY_POLICIES, toAppError, withRetry } from '@extension/shared';

const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const endpointOf = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export interface SynthesizeResult {
  // Raw little-endian 16-bit PCM, base64
  base64: string;
  sampleRateHz: number;
}

interface GeminiTtsResponse {
  candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
}

function sampleRateOf(mimeType: string | undefined): number {
  const match = /rate=(\d+)/.exec(mimeType ?? '');
  return match ? Number(match[1]) : 24_000;
}

/**
 * Turns text into speech with Gemini's TTS model. Only the background calls this: it holds the key,
 * and only audio bytes leave it, to the offscreen document for playback.
 */
export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  options: { voice?: string; model?: string; fetchImpl?: typeof fetch } = {},
): Promise<SynthesizeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;

  const response = await withRetry(async () => {
    const result = await doFetch(`${endpointOf(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          ...(options.voice
            ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } } }
            : {}),
        },
      }),
    });
    if (!result.ok) {
      const body = await result.text().catch(() => result.statusText);
      throw { status: result.status, message: body || result.statusText };
    }
    return result;
  }, RETRY_POLICIES.model).catch(error => {
    throw toAppError(error, 'Gemini could not speak that.');
  });

  const data = (await response.json()) as GeminiTtsResponse;
  const inline = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    throw new AppError('unknown', 'Gemini returned no audio.');
  }
  return { base64: inline.data, sampleRateHz: sampleRateOf(inline.mimeType) };
}
