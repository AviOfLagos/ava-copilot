import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { modelFetch } from '../../../shared/lib/voice-models/resolve';

/**
 * What the user calls the assistant, and the wake phrase that follows from it.
 *
 * The name lives in the general settings (`assistantName`); this module checks it and works out the
 * wake phrase. The on-device recogniser (Vosk, `src/offscreen/wake.ts`) only knows the words in its
 * model's vocabulary: given a grammar word it does not know, it drops the word with only a console
 * warning in the worker ("Ignoring word missing in vocabulary: 'zorblax'") and no message the page can
 * see, so "hey <unknown name>" quietly becomes "hey" (checked against hey-ava.wav: the grammar
 * ["hey zorblax", "[unk]"] decodes it as "hey [unk] [unk]") and would wake on any sentence starting
 * with it. The phrase therefore follows the name only when every word of
 * it is in the vocabulary (`wake/words.txt`, made from the model's own word list when it is
 * downloaded, or by scripts/wake-word-setup.mjs); otherwise it stays "hey ava".
 */

export const DEFAULT_ASSISTANT_NAME = 'Ava';
export const ASSISTANT_NAME_MAX = 24;
export const DEFAULT_WAKE_WORDS = ['ava'];

export type AssistantNameProblem = 'empty' | 'tooLong' | 'characters';
export type AssistantNameCheck = { ok: true; name: string } | { ok: false; problem: AssistantNameProblem };

// Letters (any script), spaces, hyphens and apostrophes; it must start with a letter
const NAME_PATTERN = /^\p{L}[\p{L}\p{M} '-]*$/u;

/** Trims and checks a name the user typed: 1–24 characters of letters, spaces, hyphens and apostrophes. */
export function checkAssistantName(raw: string): AssistantNameCheck {
  const name = raw.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, problem: 'empty' };
  if ([...name].length > ASSISTANT_NAME_MAX) return { ok: false, problem: 'tooLong' };
  if (!NAME_PATTERN.test(name)) return { ok: false, problem: 'characters' };
  return { ok: true, name };
}

/** The name to show: the stored one when it is valid, otherwise "Ava". */
export function assistantNameOf(stored: string | undefined | null): string {
  const check = checkAssistantName(stored ?? '');
  return check.ok ? check.name : DEFAULT_ASSISTANT_NAME;
}

/** The recogniser's words for a name: lower case, split at spaces and hyphens, outer apostrophes dropped. */
export function wakeWordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s-]+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

export interface WakeChoice {
  /** The words said after "hey", e.g. ['ava'] */
  words: string[];
  /** The whole phrase, e.g. "hey ava" */
  phrase: string;
  /** Whether the phrase is the user's name (true for Ava itself) */
  followsName: boolean;
  /** Words of the name the model does not know; empty when it follows the name */
  missing: string[];
  /** The vocabulary could not be read, so a custom name could not be checked */
  unchecked: boolean;
}

const phraseOf = (words: string[]) => ['hey', ...words].join(' ');

/**
 * The wake phrase for a name: "hey <name>" when every word is in the model's vocabulary, otherwise
 * "hey ava". A `null` vocabulary (not installed, or unreadable) keeps "hey ava" for any other name.
 */
export function chooseWakePhrase(name: string, vocabulary: ReadonlySet<string> | null): WakeChoice {
  const words = wakeWordsOf(assistantNameOf(name));
  const isDefault = words.join(' ') === DEFAULT_WAKE_WORDS.join(' ');
  const fallback = { words: DEFAULT_WAKE_WORDS, phrase: phraseOf(DEFAULT_WAKE_WORDS), followsName: isDefault };
  if (isDefault) return { ...fallback, missing: [], unchecked: false };
  if (!vocabulary) return { ...fallback, missing: words, unchecked: true };
  const missing = words.filter(word => !vocabulary.has(word));
  if (missing.length || !words.length) return { ...fallback, missing, unchecked: false };
  return { words, phrase: phraseOf(words), followsName: true, missing: [], unchecked: false };
}

/** Parses words.txt (one word per line). */
export function parseVocabulary(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
}

let vocabulary: Promise<Set<string> | null> | null = null;

/** The wake model's vocabulary, read once (downloaded copy, else packed); null when it is not there yet. */
export function loadWakeVocabulary(): Promise<Set<string> | null> {
  vocabulary ??= modelFetch(chrome.runtime.getURL('wake/words.txt'))
    .then(async response => (response.ok ? parseVocabulary(await response.text()) : null))
    .catch(() => null)
    .then(result => {
      // A missing file may be installed later: try again next time
      if (!result) vocabulary = null;
      return result;
    });
  return vocabulary;
}

export interface OnboardingState {
  // When the first-run setup was finished or skipped; 0 until then
  completedAt: number;
}

export type OnboardingStorage = BaseStorage<OnboardingState> & {
  complete: () => Promise<void>;
};

const onboarding = createStorage<OnboardingState>(
  'onboarding',
  { completedAt: 0 },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

/** Whether the first-run setup has been seen. A key of its own, so installs from before it see it once too. */
export const onboardingStore: OnboardingStorage = {
  ...onboarding,
  async complete() {
    await onboarding.set({ completedAt: Date.now() });
  },
};
