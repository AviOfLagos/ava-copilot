/**
 * Spike only. Two of the user's agent profiles, as the one generic worker agent would look them up.
 * In Avi Brain they would come from the companion's own profile store, keyed by the id the auth step
 * puts on the session; nothing secret is ever part of a profile.
 */
export interface ProbeProfile {
  id: string;
  model: string;
  instructions: string;
  tools: string[];
}

const PROFILES: Record<string, ProbeProfile> = {
  writer: {
    id: 'writer',
    model: 'model-writer',
    instructions: 'PROFILE-WRITER: you write short release notes.',
    tools: ['shout'],
  },
  analyst: {
    id: 'analyst',
    model: 'model-analyst',
    instructions: 'PROFILE-ANALYST: you work with numbers.',
    tools: ['add', 'danger'],
  },
};

export function profileFor(id: unknown): ProbeProfile {
  const profile = typeof id === 'string' ? PROFILES[id] : undefined;
  if (!profile) throw new Error(`Unknown profile ${String(id)}`);
  return profile;
}
