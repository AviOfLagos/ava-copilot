import type { ModelCatalogEntry, ModelRole } from './types';

/**
 * What a model can do, as tags in `ModelCatalogEntry.modalities`:
 * - what goes in: `text`, `image`, `audio`, `video`, `file`;
 * - what it is: `chat` (answers in text, usable with createChatModel), `embedding`, `speech` (text to speech),
 *   `transcription` (speech to text only), `live` (realtime audio sessions), `image-output` (makes images),
 *   `search` (searches the web itself), `reasoning`, `rerank`, `moderation`.
 * Providers that say what their models do (OpenRouter, Gemini, Ollama) are read; for the rest the model's
 * name is the only clue.
 */

export const TAG = {
  chat: 'chat',
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'file',
  embedding: 'embedding',
  speech: 'speech',
  transcription: 'transcription',
  live: 'live',
  imageOutput: 'image-output',
  search: 'search',
  reasoning: 'reasoning',
  rerank: 'rerank',
  moderation: 'moderation',
} as const;

const EMBEDDING = /embed|(^|[/_-])(bge|e5|gte)[-_]|arctic-embed|nv-embed/;
const RERANK = /rerank/;
const MODERATION = /moderation|guard|shield|safety/;
const TRANSCRIPTION = /whisper|transcribe|parakeet|canary|(^|[/_-])asr([/_-]|$)/;
const SPEECH = /(^|[/_.-])tts([/_.-]|$)|text-to-speech|fastpitch|magpie|kokoro|orpheus/;
const IMAGE_OUTPUT =
  /dall-e|gpt-image|imagen|flux|sdxl|stable-diffusion|image-generation|-image(-preview)?$|playground-v/;
const LIVE = /realtime|native-audio|(^|[/_.-])live([/_.-]|$)/;
const VISION =
  /vision|(^|[/_.:-])vl([/_.:-]|$)|-vl\b|vlm|llava|pixtral|moondream|gemma-?3|minicpm-v|llama-3\.2-(11|90)b|llama-4|gpt-4o|gpt-4\.1|gpt-5|gpt-6|(^|[/_-])o[34]([/_-]|$)|claude|gemini|grok-4|grok-2-vision|multimodal|mistral-(small|medium)-3|kimi-vl|qwen3-vl|qwen2\.5-?vl/;
const AUDIO_IN = /audio-preview|gpt-4o-audio|gemini|phi-4-multimodal|qwen2-audio|voxtral/;
const SEARCH = /search|sonar|:online$|perplexity/;
const REASONING =
  /reason|think|(^|[/_-])(r1|o1|o3|o4)([/_:-]|$)|qwq|deepseek-v4|gpt-5|gpt-6|opus|sonnet|gemini-2\.5|gemini-3|grok-4|magistral|nemotron-(super|ultra)/;

/** Tags guessed from a model's name, for providers that only list ids. */
export function tagsFromName(model: string): string[] {
  const name = model.toLowerCase();
  if (EMBEDDING.test(name)) return [TAG.embedding, TAG.text];
  if (RERANK.test(name)) return [TAG.rerank, TAG.text];
  if (TRANSCRIPTION.test(name)) return [TAG.transcription, TAG.audio];
  if (SPEECH.test(name)) return [TAG.speech, TAG.text];
  if (IMAGE_OUTPUT.test(name)) return [TAG.imageOutput, TAG.text];
  if (LIVE.test(name)) return [TAG.live, TAG.audio, TAG.text];
  if (MODERATION.test(name)) return [TAG.moderation, TAG.text];
  const tags: string[] = [TAG.chat, TAG.text];
  if (VISION.test(name)) tags.push(TAG.image);
  if (AUDIO_IN.test(name)) tags.push(TAG.audio);
  if (SEARCH.test(name)) tags.push(TAG.search);
  if (REASONING.test(name)) tags.push(TAG.reasoning);
  return tags;
}

/** Adds tags without repeating any. */
export function withTags(tags: string[], ...more: (string | false | null | undefined)[]): string[] {
  return [...new Set([...tags, ...more.filter((tag): tag is string => Boolean(tag))])];
}

export function hasTag(entry: Pick<ModelCatalogEntry, 'modalities'>, tag: string): boolean {
  return entry.modalities.includes(tag);
}

/** Whether a model can serve a role at all. */
export function fitsRole(entry: ModelCatalogEntry, role: ModelRole): boolean {
  const chat = hasTag(entry, TAG.chat);
  switch (role) {
    case 'fast':
    case 'smart':
      return chat;
    case 'vision':
      return chat && hasTag(entry, TAG.image);
    case 'local':
      return chat && entry.local;
    case 'embed':
      return hasTag(entry, TAG.embedding);
    case 'transcribe':
      // Transcription here is a chat model given the audio (createChatModel), as meetings do
      return chat && hasTag(entry, TAG.audio);
    case 'realtime':
      return hasTag(entry, TAG.live);
    case 'tts':
      return hasTag(entry, TAG.speech);
    case 'search':
      return chat && hasTag(entry, TAG.search);
  }
}

// Words, not substrings: "gemini" holds "mini"
const FAST_NAME =
  /flash|haiku|(^|[/_.:-])(mini|lite|small|nano|fast|instant|turbo|tiny|(0\.5|1|1\.5|2|3|4|7|8|9|12|14)b)([/_.:-]|$)/;
const SMART_NAME =
  /(^|[/_.:-])pro([/_.:-]|$)|opus|sonnet|large|max|ultra|reason|think|(^|[/_:-])(27|30|32|49|70|72|90|110|120|235|405|480|671)b([/_:-]|$)|gpt-6|deepseek-v4|(^|[/_-])(r1|o3|o4)([/_:-]|$)|nemotron-(super|ultra)/;

export interface ScoreContext {
  // "<providerId>:<model>" the user picked in a provider's model list or for an agent
  preferred: Set<string>;
  // Providers the user's agent models use
  agentProviders: Set<string>;
}

/**
 * How well a model suits a role, higher is better. A heuristic: the user's own picks first, then what the
 * name says about size and speed, then price (cheap for fast work), then context length and tool support.
 * Local models rank below healthy cloud ones except for the local role.
 */
export function scoreForRole(entry: ModelCatalogEntry, role: ModelRole, context: ScoreContext): number {
  const name = entry.model.toLowerCase();
  let score = 0;
  if (context.preferred.has(entry.id)) score += 30;
  if (context.agentProviders.has(entry.providerId)) score += 8;
  if (entry.health === 'ok') score += 5;

  const fastName = FAST_NAME.test(name);
  const smartName = SMART_NAME.test(name);
  const price = entry.outputUsdPerM ?? entry.inputUsdPerM;
  if (role === 'smart') {
    if (smartName) score += 20;
    if (fastName && !smartName) score -= 10;
    if (hasTag(entry, TAG.reasoning)) score += 6;
    if (price !== null && price > 0) score += Math.min(10, Math.log10(price + 1) * 8);
    if (entry.contextTokens) score += Math.min(8, Math.max(0, Math.log2(entry.contextTokens / 8192)) * 2);
  } else if (role === 'fast') {
    if (fastName) score += 20;
    if (smartName && !fastName) score -= 10;
    if (price !== null) score -= Math.min(15, Math.log10(price + 1) * 10);
  } else if (role === 'embed') {
    // Free and private, and its vectors never need a key
    if (entry.local) score += 5;
  } else if (role === 'realtime') {
    if (/native-audio/.test(name)) score += 6;
  } else if (role === 'search' || role === 'transcribe' || role === 'vision') {
    if (fastName) score += 6;
  }

  if (hasTag(entry, TAG.chat)) {
    if (entry.tools === true) score += 5;
    if (entry.tools === false) score -= 10;
  }
  if (entry.local && role !== 'local' && role !== 'embed') score -= 15;
  // Previews and experiments change under the user; dated snapshots are fine
  if (/(^|[/_.:-])(exp|experimental)([/_.:-]|$)/.test(name)) score -= 3;
  return score;
}

/**
 * The models a picker offers for one provider. Once the registry has listed the provider, its catalog is the
 * source of truth: the listed chat models, the ones saved with the provider first. Before that, the names saved
 * with the provider (which start as the built-in suggestions).
 */
export function chatModelChoices(
  providerId: string,
  savedNames: string[] | undefined,
  catalog: ModelCatalogEntry[],
): string[] {
  const listed = catalog
    .filter(entry => entry.providerId === providerId && hasTag(entry, TAG.chat))
    .map(entry => entry.model)
    .sort((a, b) => a.localeCompare(b));
  const saved = savedNames ?? [];
  if (listed.length === 0) return [...new Set(saved)];
  const available = new Set(listed);
  return [...new Set([...saved.filter(name => available.has(name)), ...listed])];
}
