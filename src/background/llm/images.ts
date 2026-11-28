import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { generateImage } from 'ai';
import type { ImageModel } from 'ai';
import { ProviderTypeEnum, getProviderTypeByProviderId, isOpenAICompatibleType } from '@extension/storage';
import type { ProviderConfig } from '@extension/storage';
import { AppError } from '@extension/shared';

/**
 * Pictures from a description (#204), with the model of the "image" role. Only providers whose AI SDK package makes
 * images: OpenAI and OpenAI-compatible endpoints, Gemini (Imagen and the Gemini image models), and Grok.
 */

export interface MadePicture {
  base64: string;
  mediaType: string;
}

/** The provider's image model, or null when this provider cannot make pictures here. */
export function imageModelFor(provider: ProviderConfig, providerId: string, model: string): ImageModel | null {
  const type = provider.type ?? getProviderTypeByProviderId(providerId);
  const apiKey = provider.apiKey;
  switch (type) {
    case ProviderTypeEnum.OpenAI:
      return createOpenAI({ apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) }).image(model);
    case ProviderTypeEnum.Gemini:
      return createGoogle({ apiKey }).image(model);
    case ProviderTypeEnum.Grok:
      return createXai({ apiKey }).image(model);
    default:
      // An OpenAI-compatible endpoint may serve /images/generations too
      if (isOpenAICompatibleType(type) && provider.baseUrl) {
        return createOpenAI({ apiKey, baseURL: provider.baseUrl }).image(model);
      }
      return null;
  }
}

// About what one square picture costs, in US dollars, from the providers' price lists (medium quality, 1024 px).
// A guess to show before spending, never a bill: an unknown model says "unknown" instead.
const PRICE_PER_PICTURE: [RegExp, number][] = [
  [/gpt-image-1-mini/, 0.011],
  [/gpt-image|chatgpt-image/, 0.042],
  [/dall-e-3/, 0.04],
  [/dall-e-2/, 0.02],
  [/gemini-3[.\d-]*pro-image/, 0.134],
  [/gemini-[\d.]+-flash-image/, 0.039],
  [/imagen-[\d.]+-fast/, 0.02],
  [/imagen-[\d.]+-ultra/, 0.06],
  [/imagen/, 0.04],
  [/grok-imagine-image-pro/, 0.07],
  [/grok-imagine-image|grok-2-image/, 0.02],
];

/** About what one picture costs with this model, or null when unknown. */
export function pictureCostUsd(model: string): number | null {
  const name = model.toLowerCase();
  return PRICE_PER_PICTURE.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/**
 * What is asked of the provider, so the price said is the price paid: OpenAI's GPT Image at medium quality (its
 * default "auto" may pick high, several times dearer) as a compressed JPEG, one 1024 px square.
 */
export function pictureOptions(model: string): Pick<Parameters<typeof generateImage>[0], 'size' | 'providerOptions'> {
  const name = model.toLowerCase();
  if (/gpt-image|chatgpt-image/.test(name)) {
    return {
      size: '1024x1024',
      providerOptions: { openai: { quality: 'medium', outputFormat: 'jpeg', outputCompression: 85 } },
    };
  }
  if (/dall-e/.test(name)) return { size: '1024x1024' };
  return {};
}

/** Makes one picture. */
export async function makePicture(
  imageModel: ImageModel,
  model: string,
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<MadePicture> {
  const { image } = await generateImage({
    model: imageModel,
    prompt,
    n: 1,
    maxRetries: 1,
    abortSignal,
    ...pictureOptions(model),
  });
  if (!image?.base64) throw new AppError('unavailable', 'The picture model returned no picture.');
  return { base64: image.base64, mediaType: image.mediaType || 'image/png' };
}
