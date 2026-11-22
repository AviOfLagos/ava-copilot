// The English words (about 80,000: SCOWL sizes 10 to 60, American and British spellings, letters only). A heard word
// that is in it is a real word, and the correction never changes a real word by itself. Source and licence:
// data/README.md and data/SCOWL-COPYRIGHT.txt.
import raw from './data/english-words.txt?raw';

let words: Set<string> | null = null;

/** Whether `word` is an ordinary English word. */
export function isEnglishWord(word: string): boolean {
  words ??= new Set(raw.split('\n').filter(Boolean));
  return words.has(word.toLowerCase());
}

/** How many words the list holds (for the tests). */
export function englishWordCount(): number {
  isEnglishWord('a');
  return words?.size ?? 0;
}
