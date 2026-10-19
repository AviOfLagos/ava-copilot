import { z } from 'zod';
import type { AgentProfile, AgentProfileFields, AgentTrigger } from '@extension/storage';
import { cleanVoices } from '@extension/storage/lib/personalities/personalities';
import { checkSchedule, isHttpUrl } from '../workflows/spec';
import { hostInDomains, LISTEN_PATTERN, normalizeDomain, tabPatternIssue, TOPIC_PATTERN } from './patterns';

/**
 * An agent's profile as data: what it is told, which sites it may reach, which model role it uses, when it
 * wakes, which topics it reads and writes on the bus, and its budget. Pure (no storage, no browser), shared
 * by the background, the drafting model's checks and the panel.
 */

// The roles an agent's browser work can run on
export const AGENT_ROLES = ['smart', 'fast', 'vision', 'local'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const MAX_TRIGGERS = 8;
export const MAX_DOMAINS = 30;
export const MAX_TOPICS = 10;
// The skill matcher loads at most three skills per step
export const MAX_SKILLS = 3;
export const MAX_INSTRUCTIONS = 4000;
// Areas of work one agent owns, and how long an area's name and the charter may be
export const MAX_OWNS = 6;
export const MAX_AREA = 40;
export const MAX_CHARTER = 200;

export const DEFAULT_AGENT_BUDGET = { dailyUsd: 1, maxStepsPerRun: 40, runsPerDay: 24 };

export function userTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    cron: z.string().trim().min(9).max(120),
    timezone: z.string().trim().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal('tab'), urlPattern: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('inbox'), source: z.string().trim().max(80).optional() }),
  z.object({ type: z.literal('topic'), topic: z.string().trim().toLowerCase().min(1).max(64) }),
  z.object({ type: z.literal('meeting_ended') }),
  z.object({ type: z.literal('manual') }),
]);

const budgetSchema = z.object({
  // No cap of its own when null; the user's daily cap still holds
  dailyUsd: z.number().min(0).max(100).nullable().default(DEFAULT_AGENT_BUDGET.dailyUsd),
  maxStepsPerRun: z.number().int().min(1).max(200).default(DEFAULT_AGENT_BUDGET.maxStepsPerRun),
  runsPerDay: z.number().int().min(1).max(288).default(DEFAULT_AGENT_BUDGET.runsPerDay),
});

export const profileFieldsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  avatar: z.string().trim().max(8).default(''),
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS),
  skills: z.array(z.string().trim().toLowerCase().min(1).max(64)).max(MAX_SKILLS).default([]),
  connectors: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  domains: z.array(z.string().trim().max(300)).max(MAX_DOMAINS).default([]),
  modelRole: z.enum(AGENT_ROLES).default('smart'),
  workspaceId: z.string().trim().min(1).max(100).nullable().default(null),
  executor: z.enum(['browser', 'companion']).default('browser'),
  triggers: z.array(triggerSchema).max(MAX_TRIGGERS).default([]),
  subscribes: z.array(z.string().trim().toLowerCase().max(64)).max(MAX_TOPICS).default([]),
  publishes: z.array(z.string().trim().toLowerCase().max(64)).max(MAX_TOPICS).default([]),
  budget: budgetSchema.default(DEFAULT_AGENT_BUDGET),
  startUrl: z.string().trim().max(2000).nullable().default(null),
  inboxResults: z.boolean().default(true),
  owns: z.array(z.string().trim().max(MAX_AREA)).max(MAX_OWNS).default([]),
  charter: z.string().trim().max(MAX_CHARTER).nullable().default(null),
  personalityId: z.string().trim().max(100).nullable().default(null),
  voices: z
    .object({
      live: z.string().max(200).optional(),
      kitten: z.string().max(200).optional(),
      kokoro: z.string().max(200).optional(),
      system: z.string().max(200).optional(),
    })
    .default({}),
});

export type ProfileCheck = { ok: true; profile: AgentProfileFields } | { ok: false; issues: string[] };

const FIELD_NAMES: Record<string, string> = {
  name: 'The name',
  avatar: 'The avatar',
  instructions: 'The instructions',
  skills: 'The skills',
  connectors: 'The connectors',
  domains: 'The sites',
  modelRole: 'The model role',
  workspaceId: 'The workspace',
  executor: 'Where it works',
  triggers: 'The triggers',
  subscribes: 'The topics it listens to',
  publishes: 'The topics it posts to',
  budget: 'The budget',
  startUrl: 'The start page',
  owns: 'The areas it owns',
  charter: 'The charter',
  personalityId: 'The personality',
  voices: 'The voice',
};

function describeIssue(issue: z.core.$ZodIssue): string {
  const [field, ...rest] = issue.path.map(String);
  const where = FIELD_NAMES[field ?? ''] ?? 'The agent';
  return `${where}${rest.length ? ` (${rest.join('.')})` : ''}: ${issue.message}`;
}

function sameTrigger(a: AgentTrigger, b: AgentTrigger): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Checks a profile fully and puts it in its normal form: sites as host names, topics in lower case, one
 * topic trigger per topic it listens to (and the other way round), no repeated triggers. The issues are plain
 * sentences, fit for the user or for the model that drafted the agent.
 */
export function validateProfile(input: unknown, now = Date.now()): ProfileCheck {
  const parsed = profileFieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 10).map(describeIssue) };
  const fields = parsed.data;
  const issues: string[] = [];

  const domains: string[] = [];
  for (const entry of fields.domains) {
    if (!entry.trim()) continue;
    const domain = normalizeDomain(entry);
    if (!domain) issues.push(`"${entry}" is not a site; write a host name like "example.com".`);
    else if (!domains.includes(domain)) domains.push(domain);
  }

  const startUrl = fields.startUrl?.trim() || null;
  if (startUrl) {
    if (!isHttpUrl(startUrl)) {
      issues.push(`The start page "${startUrl}" must be a full http or https address.`);
    } else if (!hostInDomains(new URL(startUrl).hostname, domains)) {
      issues.push(`The start page is on ${new URL(startUrl).hostname}, which is not one of its sites.`);
    }
  }

  for (const skill of fields.skills) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) issues.push(`"${skill}" is not a skill name.`);
  }

  const triggers: AgentTrigger[] = [];
  const listens = new Set<string>();
  for (const trigger of fields.triggers) {
    const normal: AgentTrigger =
      trigger.type === 'schedule'
        ? { type: 'schedule', cron: trigger.cron, timezone: trigger.timezone || userTimezone() }
        : trigger.type === 'inbox'
          ? trigger.source
            ? { type: 'inbox', source: trigger.source }
            : { type: 'inbox' }
          : trigger;
    if (normal.type === 'schedule') {
      const check = checkSchedule(normal.cron, normal.timezone ?? userTimezone(), now);
      if ('error' in check) issues.push(check.error);
    } else if (normal.type === 'tab') {
      const problem = tabPatternIssue(normal.urlPattern);
      if (problem) issues.push(problem);
    } else if (normal.type === 'topic') {
      if (!LISTEN_PATTERN.test(normal.topic)) {
        issues.push(`"${normal.topic}" is not a topic; use lower case letters, digits, ".", "_" or "-".`);
      }
      listens.add(normal.topic);
    }
    if (!triggers.some(existing => sameTrigger(existing, normal))) triggers.push(normal);
  }
  for (const topic of fields.subscribes) {
    if (!topic) continue;
    if (!LISTEN_PATTERN.test(topic)) {
      issues.push(`"${topic}" is not a topic; use lower case letters, digits, ".", "_" or "-".`);
    } else if (!listens.has(topic)) {
      listens.add(topic);
      triggers.push({ type: 'topic', topic });
    }
  }
  if (triggers.length > MAX_TRIGGERS) issues.push(`An agent has at most ${MAX_TRIGGERS} triggers.`);

  const publishes = [...new Set(fields.publishes.filter(Boolean))];
  for (const topic of publishes) {
    if (!TOPIC_PATTERN.test(topic)) {
      issues.push(`"${topic}" is not a topic to post to; use lower case letters, digits, ".", "_" or "-".`);
    } else if (
      [...listens].some(
        listened => listened === topic || (listened.endsWith('*') && topic.startsWith(listened.slice(0, -1))),
      )
    ) {
      issues.push(`It posts to "${topic}" and listens to it too, so it would set itself off.`);
    }
  }

  const owns: string[] = [];
  for (const entry of fields.owns) {
    const area = normalArea(entry);
    if (!area) continue;
    if (!areaKey(area)) issues.push(`"${entry}" is not an area of work; name it in a word or two, like "email".`);
    else if (!owns.some(existing => areaKey(existing) === areaKey(area))) owns.push(area);
  }

  if (fields.executor === 'companion') {
    issues.push('Agents that run commands on the Mac need the Nex Brain companion, which is not set up yet.');
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    profile: {
      ...fields,
      avatar: fields.avatar || initialsOf(fields.name),
      domains,
      startUrl,
      triggers,
      subscribes: [...listens],
      publishes,
      skills: [...new Set(fields.skills)],
      connectors: [...new Set(fields.connectors)],
      owns,
      charter: fields.charter?.trim() || null,
      personalityId: fields.personalityId?.trim() || null,
      voices: cleanVoices(fields.voices),
    },
  };
}

// ── Ownership ─────────────────────────────────────────────────────────────────────────────────────

/** An area as the user wrote it, tidied: lower case, single spaces. */
export function normalArea(area: string): string {
  return area.trim().toLowerCase().replace(/\s+/g, ' ');
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.length > 4 && /(ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * What an area is compared by, so "Email", "emails" and "e-mail" are one area, and "Meeting follow-ups" is
 * "meeting follow-up": lower case, letters and digits only, each word singular.
 */
export function areaKey(area: string): string {
  return normalArea(area)
    .replace(/\be-mail/g, 'email')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

/** Whether a chat in one of these workspaces could see both: the same workspace, or either in none. */
export function workspacesOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || a === b;
}

/** Created, switched on: the agents whose areas count. */
export const ownsWork = (agent: Pick<AgentProfile, 'status' | 'enabled'>): boolean =>
  !isDraftAgent(agent) && agent.enabled;

/**
 * The first area this agent would own that a switched-on agent a chat could see alongside it already owns, and
 * who owns it; null when there is none. Agents in no workspace are seen from every workspace, so they clash with
 * all of them.
 */
export function ownershipClash(
  profile: Pick<AgentProfileFields, 'owns' | 'workspaceId'>,
  agentId: string | null,
  others: readonly AgentProfile[],
): { area: string; owner: AgentProfile } | null {
  for (const area of profile.owns ?? []) {
    const key = areaKey(area);
    const owner = others.find(
      other =>
        other.id !== agentId &&
        ownsWork(other) &&
        workspacesOverlap(other.workspaceId, profile.workspaceId) &&
        (other.owns ?? []).some(theirs => areaKey(theirs) === key),
    );
    if (owner) return { area, owner };
  }
  return null;
}

/** The refusal for a clash, in plain words. */
export function clashMessage(clash: { area: string; owner: Pick<AgentProfile, 'name'> }): string {
  return `"${clash.owner.name}" already owns ${clash.area}. Two agents cannot own the same area: take it off one of them, or pause "${clash.owner.name}" first.`;
}

/** Up to two initials, for an agent with no emoji. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map(word => word[0]!.toUpperCase())
      .join('') || 'A'
  );
}

/** The fields of a stored agent that the user decides, for a diff or a draft. */
export function fieldsOf(agent: AgentProfileFields): AgentProfileFields {
  return {
    name: agent.name,
    avatar: agent.avatar,
    instructions: agent.instructions,
    skills: [...agent.skills],
    connectors: [...agent.connectors],
    domains: [...agent.domains],
    modelRole: agent.modelRole,
    workspaceId: agent.workspaceId,
    executor: agent.executor,
    triggers: agent.triggers.map(trigger => ({ ...trigger })),
    subscribes: [...agent.subscribes],
    publishes: [...agent.publishes],
    budget: { ...agent.budget },
    startUrl: agent.startUrl ?? null,
    inboxResults: agent.inboxResults ?? true,
    owns: [...(agent.owns ?? [])],
    charter: agent.charter ?? null,
    personalityId: agent.personalityId ?? null,
    voices: { ...(agent.voices ?? {}) },
  };
}

export const isDraftAgent = (agent: Pick<AgentProfile, 'status'>): boolean => agent.status === 'draft';

/** A new agent record holding only a draft: it runs once the user clicks Create. */
export function newAgentRecord(
  profile: AgentProfileFields,
  request: string,
  template: string | null = null,
): AgentProfile {
  const now = Date.now();
  return {
    ...fieldsOf(profile),
    id: crypto.randomUUID(),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    draft: { profile: fieldsOf(profile), base: null, request, createdAt: now },
    version: 0,
    pausedReason: null,
    failuresInRow: 0,
    lastRunAt: null,
    lastRunStatus: null,
    template,
  };
}

// ── What a draft changes ──────────────────────────────────────────────────────────────────────────

export type ProfileField = keyof AgentProfileFields;

export interface FieldChange {
  field: ProfileField;
  before: string;
  after: string;
}

const DIFF_FIELDS: ProfileField[] = [
  'name',
  'avatar',
  'instructions',
  'startUrl',
  'domains',
  'triggers',
  'publishes',
  'subscribes',
  'modelRole',
  'budget',
  'skills',
  'connectors',
  'workspaceId',
  'inboxResults',
  'owns',
  'charter',
  'personalityId',
  'voices',
];

/** A trigger in plain words, for the model and the diff. */
export function triggerWords(trigger: AgentTrigger): string {
  switch (trigger.type) {
    case 'schedule':
      return `on the schedule "${trigger.cron}"${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
    case 'tab':
      return `when a page matching "${trigger.urlPattern}" opens or changes`;
    case 'inbox':
      return trigger.source ? `when an Inbox item from ${trigger.source} arrives` : 'when an Inbox item arrives';
    case 'topic':
      return `when another agent posts to "${trigger.topic}"`;
    case 'meeting_ended':
      return 'when a meeting the user took notes of ends';
    case 'manual':
      return 'when asked';
  }
}

function fieldText(field: ProfileField, profile: AgentProfileFields | null): string {
  if (!profile) return '';
  const value = profile[field];
  switch (field) {
    case 'triggers':
      return profile.triggers.map(triggerWords).join('; ');
    case 'budget': {
      const budget = profile.budget;
      return `${budget.dailyUsd === null ? 'no daily cap' : `$${budget.dailyUsd.toFixed(2)} a day`}, ${budget.maxStepsPerRun} steps a run, ${budget.runsPerDay} runs a day`;
    }
    case 'inboxResults':
      return (profile.inboxResults ?? true) ? 'yes' : 'no';
    case 'owns':
      return (profile.owns ?? []).join(', ');
    case 'charter':
      return profile.charter ?? '';
    case 'personalityId':
      return profile.personalityId ?? '';
    case 'voices':
      return Object.entries(profile.voices ?? {})
        .filter(([, voice]) => voice)
        .map(([slot, voice]) => `${slot}: ${voice}`)
        .join(', ');
    default:
      if (Array.isArray(value)) return value.join(', ');
      return value === null || value === undefined ? '' : String(value);
  }
}

/** The fields a draft changes, with their old and new values in words; every field for a new agent. */
export function diffProfiles(base: AgentProfileFields | null, next: AgentProfileFields): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of DIFF_FIELDS) {
    const before = fieldText(field, base);
    const after = fieldText(field, next);
    if (before !== after) changes.push({ field, before, after });
  }
  return changes;
}

/** One line about an agent, for the browser agent and voice. */
export function agentSummary(profile: AgentProfileFields): string {
  const when = profile.triggers.length ? profile.triggers.map(triggerWords).join('; ') : 'only when asked';
  const sites = profile.domains.length ? `; sites: ${profile.domains.join(', ')}` : '';
  const owns = profile.owns?.length ? `; owns ${profile.owns.join(', ')}` : '';
  return `runs ${when}${sites}${owns}`;
}
