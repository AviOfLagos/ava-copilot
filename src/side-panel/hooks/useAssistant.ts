import { useEffect, useState } from 'react';
import {
  DEFAULT_ASSISTANT_NAME,
  assistantNameOf,
  chooseWakePhrase,
  generalSettingsStore,
  loadWakeVocabulary,
} from '@extension/storage';
import type { WakeChoice } from '@extension/storage';

/** The assistant's name as the user set it, kept up to date; "Ava" until it is read. */
export function useAssistantName(): string {
  const [name, setName] = useState(() => assistantNameOf(generalSettingsStore.getSnapshot()?.assistantName));
  useEffect(() => {
    const read = () => void generalSettingsStore.getSettings().then(s => setName(assistantNameOf(s.assistantName)));
    read();
    return generalSettingsStore.subscribe(read);
  }, []);
  return name;
}

/** The wake phrase a name would get, once the model's vocabulary is read; `null` while it loads. */
export function useWakeChoice(name: string): WakeChoice | null {
  const [vocabulary, setVocabulary] = useState<Set<string> | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadWakeVocabulary().then(words => live && setVocabulary(words));
    return () => {
      live = false;
    };
  }, []);
  if (vocabulary === undefined) return null;
  return chooseWakePhrase(name || DEFAULT_ASSISTANT_NAME, vocabulary);
}

/** "Hey Ava" for display, from a phrase like "hey ava" or "hey mary jane". */
export function displayPhrase(choice: WakeChoice | null, name: string): string {
  if (!choice) return `Hey ${DEFAULT_ASSISTANT_NAME}`;
  return choice.followsName ? `Hey ${name}` : `Hey ${DEFAULT_ASSISTANT_NAME}`;
}
