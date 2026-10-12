import { useEffect, useState } from 'react';
import { accountProfileStore } from '@extension/storage';

/** The name shown in the shell's profile button, kept current as Settings changes it. */
export function useDisplayName(): string {
  const [name, setName] = useState('');
  useEffect(() => {
    const load = () => void accountProfileStore.getDisplayName().then(setName);
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes['account-profile']) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return name;
}

/** Up to two initials from a name, for the avatar; "Y" (You) when there is none yet. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Y';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts.at(-1)![0]).toUpperCase();
}
