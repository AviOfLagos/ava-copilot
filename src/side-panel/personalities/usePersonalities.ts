import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { EMPTY_PERSONALITIES, normalizePersonalities, personalityStore, resolvePersonality } from '@extension/storage';
import type { PersonalitiesState, Personality } from '@extension/storage';

type MessageKey = Parameters<typeof t>[0];

/** The personalities' settings, kept current as any page or the background changes them. */
export function usePersonalities(): PersonalitiesState {
  const [state, setState] = useState<PersonalitiesState>(() =>
    normalizePersonalities(personalityStore.getSnapshot() ?? EMPTY_PERSONALITIES),
  );
  useEffect(() => {
    const load = () => void personalityStore.getState().then(setState);
    load();
    return personalityStore.subscribe(load);
  }, []);
  return state;
}

/** The personality in force for a chat in `workspaceId` (or none), kept current. */
export function useActivePersonality(workspaceId?: string | null): Personality {
  return resolvePersonality(usePersonalities(), workspaceId);
}

// The built-ins' names and descriptions in the user's language; a user's own are shown as written
const BUILTIN_LABELS: Record<string, { name: MessageKey; description: MessageKey }> = {
  default: { name: 'persona_builtin_default_name', description: 'persona_builtin_default_description' },
  engineer: { name: 'persona_builtin_engineer_name', description: 'persona_builtin_engineer_description' },
  accountant: { name: 'persona_builtin_accountant_name', description: 'persona_builtin_accountant_description' },
  legal: { name: 'persona_builtin_legal_name', description: 'persona_builtin_legal_description' },
  auntie: { name: 'persona_builtin_auntie_name', description: 'persona_builtin_auntie_description' },
  operator: { name: 'persona_builtin_operator_name', description: 'persona_builtin_operator_description' },
};

export function personalityName(personality: Personality): string {
  const label = personality.builtIn ? BUILTIN_LABELS[personality.id] : undefined;
  return label ? t(label.name) : personality.name;
}

export function personalityDescription(personality: Personality): string {
  const label = personality.builtIn ? BUILTIN_LABELS[personality.id] : undefined;
  return label ? t(label.description) : personality.description;
}
