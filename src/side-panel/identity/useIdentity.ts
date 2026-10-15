import { useEffect, useState } from 'react';
import {
  aboutYouStore,
  coreIdentityStore,
  DEFAULT_VOICE_IDENTITY,
  EMPTY_ABOUT_YOU,
  EMPTY_CORE,
  normalizeAboutYou,
  voiceIdentityStore,
} from '@extension/storage';
import type { AboutYouState, CoreIdentity, VoiceIdentitySettings } from '@extension/storage';

/** A store's value, kept current as the background changes it. The panel only reads; changes go as commands. */
function useStore<T>(read: () => Promise<T>, subscribe: (listener: () => void) => () => void, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const load = () => void read().then(setValue);
    load();
    return subscribe(load);
    // The stores are module singletons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

export const useAboutYou = (): AboutYouState =>
  useStore(
    () => aboutYouStore.getState().then(normalizeAboutYou),
    listener => aboutYouStore.subscribe(listener),
    EMPTY_ABOUT_YOU,
  );

export const useCoreIdentity = (): CoreIdentity =>
  useStore(
    () => coreIdentityStore.getCore(),
    listener => coreIdentityStore.subscribe(listener),
    EMPTY_CORE,
  );

export const useVoiceIdentity = (): VoiceIdentitySettings =>
  useStore(
    () => voiceIdentityStore.getSettings(),
    listener => voiceIdentityStore.subscribe(listener),
    DEFAULT_VOICE_IDENTITY,
  );
