const DEFAULT_MAX_LEN = 200;

/** Breaks one piece of text no sentence boundary fits into, at the last space before the limit. */
function splitLong(text: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const spaceAt = rest.lastIndexOf(' ', maxLen);
    const cut = spaceAt > 0 ? spaceAt : maxLen;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits speakable text into pieces no longer than `maxLen`, breaking at sentence ends or line
 * breaks so each piece can be spoken as one whole utterance. Nothing is skipped: a sentence longer
 * than `maxLen` by itself is broken at the last space before the limit instead. An engine that must
 * queue utterances up front (`chrome.tts`) uses this to know where one ends and the next begins.
 */
export function chunkText(text: string, maxLen: number = DEFAULT_MAX_LEN): string[] {
  const sentences = text
    .split(/(?<=[.!?:;])\s+|\n+/)
    .map(part => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const pieces = sentence.length <= maxLen ? [sentence] : splitLong(sentence, maxLen);
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > maxLen) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
