/**
 * Text handling for the local voices, with no model in it: sentence chunks (so the first sentence plays while the
 * next is made), KittenTTS's tokenizer split and style row, and Kokoro's phoneme fixes. Pure, so it is unit tested.
 */

// A chunk longer than this is cut at a comma or a space: the models handle a sentence, not a page
const MAX_CHUNK_CHARS = 220;
// The first chunk is kept shorter: nothing is heard until it is made, and the next is made while it plays
const FIRST_CHUNK_CHARS = 90;

/**
 * Splits text into sentence-sized chunks that keep their own punctuation. A sentence longer than the limit is cut at
 * its last comma, else its last space, before it; the first chunk has a lower limit so speech starts sooner.
 */
export function splitSentences(text: string, maxChars = MAX_CHUNK_CHARS, firstMaxChars = FIRST_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [clean];
  const chunks: string[] = [];
  for (const raw of sentences) {
    let sentence = raw.trim();
    for (let limit = chunks.length ? maxChars : firstMaxChars; sentence.length > limit; limit = maxChars) {
      const window = sentence.slice(0, limit);
      const comma = window.lastIndexOf(', ');
      const space = window.lastIndexOf(' ');
      const cut = comma > limit / 3 ? comma + 1 : space > 0 ? space : limit;
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (/[\p{L}\p{N}]/u.test(sentence)) chunks.push(sentence);
  }
  return chunks;
}

/** KittenTTS ends every chunk with punctuation, or the model trails off. */
export function ensurePunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?,;:]$/.test(trimmed) ? trimmed : `${trimmed},`;
}

/** Python's `re.findall(r"\w+|[^\w\s]", text)`, which KittenTTS runs over the phonemes before its ids. */
export function basicEnglishTokenize(text: string): string[] {
  return text.match(/[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_\s]/gu) ?? [];
}

/** The style vector for an utterance of `tokens` tokens: row min(tokens, rows - 1) of a voice's table. */
export function styleRow(voice: Float32Array, rowLength: number, tokens: number): Float32Array {
  const rows = Math.floor(voice.length / rowLength);
  const row = Math.max(0, Math.min(tokens, rows - 1));
  return voice.slice(row * rowLength, (row + 1) * rowLength);
}

/** The phoneme fixes Kokoro was trained with (from kokoro-js, Apache-2.0), for American English. */
export function kokoroPhonemes(phonemes: string): string {
  return phonemes
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
    .trim();
}

/** Drops the end of a KittenTTS clip: the model adds a click of silence there. */
export function trimTail(samples: Float32Array, tail = 5000): Float32Array {
  return samples.slice(0, Math.max(0, samples.length - tail));
}

/**
 * Cuts the quiet a model puts before and after a sentence (KittenTTS adds over half a second each side), keeping a
 * short margin, so sentences follow each other naturally and the first one is heard sooner.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.01, keepMs = 120): Float32Array {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  if (start >= end) return new Float32Array(0);
  const keep = Math.round((keepMs / 1000) * sampleRate);
  return samples.slice(Math.max(0, start - keep), Math.min(samples.length, end + keep));
}

/** Root mean square of a clip: zero for silence. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
