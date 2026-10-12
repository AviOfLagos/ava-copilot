import type { AgentProfile, AgentProfileFields } from '@extension/storage';

/** A small valid agent profile; tests change what they test. */
export function profile(overrides: Partial<AgentProfileFields> = {}): AgentProfileFields {
  return {
    name: 'Scout',
    avatar: '🔭',
    instructions: 'Read the page and list what changed.',
    skills: [],
    connectors: [],
    domains: [],
    modelRole: 'smart',
    workspaceId: null,
    executor: 'browser',
    triggers: [{ type: 'manual' }],
    subscribes: [],
    publishes: [],
    budget: { dailyUsd: 1, maxStepsPerRun: 20, runsPerDay: 10 },
    startUrl: null,
    inboxResults: true,
    ...overrides,
  };
}

/** A created, switched-on agent record. */
export function agentRecord(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const now = Date.now();
  return {
    ...profile(),
    id: crypto.randomUUID(),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    draft: null,
    version: 1,
    pausedReason: null,
    failuresInRow: 0,
    lastRunAt: null,
    lastRunStatus: null,
    template: null,
    ...overrides,
  };
}
