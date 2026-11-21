/**
 * Sections other features add to the morning brief (the growth team's Team section, docs/growth-team.md Part 5b).
 * A feature registers once at startup; the brief waits while one says it is still making its section, then asks
 * each for its sections when it is built.
 */

export interface BriefExtraSection {
  title: string;
  markdown: string;
  workspaceId: string | null;
}

export interface BriefExtra {
  id: string;
  // True while the section is still being made and the brief should wait for it
  pending(now: number): Promise<boolean>;
  sections(now: number): Promise<BriefExtraSection[]>;
}

const extras = new Map<string, BriefExtra>();

export function registerBriefExtra(extra: BriefExtra): void {
  extras.set(extra.id, extra);
}

/** Whether any feature is still making its section. One that fails to answer is not waited for. */
export async function briefExtrasPending(now: number): Promise<boolean> {
  for (const extra of extras.values()) if (await extra.pending(now).catch(() => false)) return true;
  return false;
}

/** Every feature's sections, in the order they registered. One that fails adds nothing. */
export async function briefExtraSections(now: number): Promise<(BriefExtraSection & { id: string })[]> {
  const all: (BriefExtraSection & { id: string })[] = [];
  for (const extra of extras.values()) {
    for (const section of await extra.sections(now).catch(() => [])) all.push({ ...section, id: extra.id });
  }
  return all;
}
