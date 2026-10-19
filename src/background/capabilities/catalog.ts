/**
 * What Ava can do, built from what is registered, so a new voice tool, agent action, panel place or settings
 * section shows up here without anyone editing a list. The group a tool goes under is the only thing kept by
 * hand, and a tool missing from that map still appears (under "More"): nothing registered can be left out.
 *
 * Pure: the sources are passed in (see ./sources.ts), so tests can build a catalog from fakes.
 */

export interface CapabilityEntry {
  name: string;
  description: string;
}

export interface PanelPlaceEntry {
  // The id open_place takes
  id: string;
  // The name the user sees in the panel, in their language
  label: string;
  // A settings section's place on the full-page Settings (options.html#voice/engines)
  hash?: string;
}

export interface CapabilitySources {
  // Voice tools: the core ones first, then the registered ones
  voiceTools: CapabilityEntry[];
  // What the browser agent can do in a chat: its own actions, then the registered ones
  agentActions: CapabilityEntry[];
  places: PanelPlaceEntry[];
  settingsSections: PanelPlaceEntry[];
}

export type CapabilityGroupId =
  'screen' | 'tasks' | 'meetings' | 'memory' | 'routines' | 'inbox' | 'settings' | 'conversation' | 'more';

export interface CapabilityGroup {
  id: CapabilityGroupId;
  title: string;
  entries: CapabilityEntry[];
}

export interface Capabilities {
  groups: CapabilityGroup[];
  agentActions: CapabilityEntry[];
  places: PanelPlaceEntry[];
  settingsSections: PanelPlaceEntry[];
}

export const GROUP_TITLES: Record<CapabilityGroupId, string> = {
  screen: 'Your screen and tabs',
  tasks: 'Tasks and agents',
  meetings: 'Meetings and your day',
  memory: 'Memory, knowledge, Google Drive and other chats',
  routines: 'Routines',
  inbox: 'Inbox and confirm cards',
  settings: 'Settings, the panel and checks',
  conversation: 'This conversation',
  more: 'More',
};

const GROUP_ORDER: CapabilityGroupId[] = [
  'screen',
  'tasks',
  'meetings',
  'memory',
  'routines',
  'inbox',
  'settings',
  'conversation',
  'more',
];

// Where each known tool goes; a tool not listed goes under "More", never nowhere
export const TOOL_GROUPS: Record<string, CapabilityGroupId> = {
  read_screen: 'screen',
  list_tabs: 'screen',
  read_page: 'screen',
  open_tab: 'screen',
  switch_tab: 'screen',
  list_frequent_sites: 'screen',
  run_browser_task: 'tasks',
  do_task: 'tasks',
  think: 'tasks',
  get_status: 'tasks',
  stop_tasks: 'tasks',
  list_agents: 'tasks',
  run_agent: 'tasks',
  install_skill: 'tasks',
  hand_to_agent: 'tasks',
  get_brief: 'meetings',
  get_schedule: 'meetings',
  join_next_meeting: 'meetings',
  leave_call: 'meetings',
  end_call_for_everyone: 'meetings',
  ask_meeting: 'meetings',
  start_meeting_notes: 'meetings',
  stop_meeting_notes: 'meetings',
  remember_this: 'memory',
  ask_knowledge: 'memory',
  search_chats: 'memory',
  read_chat: 'memory',
  remember: 'memory',
  update_memory: 'memory',
  where_are_we: 'memory',
  drive_search: 'memory',
  drive_read: 'memory',
  drive_save_to_knowledge: 'memory',
  run_workflow: 'routines',
  create_workflow: 'routines',
  update_workflow: 'routines',
  list_workflows: 'routines',
  read_inbox: 'inbox',
  manage_inbox: 'inbox',
  read_confirm_cards: 'inbox',
  what_can_you_do: 'settings',
  open_place: 'settings',
  check_audio: 'settings',
  check_model: 'settings',
  switch_model: 'settings',
  change_setting: 'settings',
  set_personality: 'settings',
  list_personalities: 'settings',
  list_connectors: 'settings',
  list_workspaces: 'settings',
  end_conversation: 'conversation',
};

const MAX_DESCRIPTION = 160;

/** The first sentence of a description, short enough to read in a list. */
export function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  // "e.g." and "i.e." do not end a sentence
  const first = /^((?:e\.g\.|i\.e\.|[^.!?])+[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return first.length > MAX_DESCRIPTION ? `${first.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : first;
}

/** Keeps the first entry of each name: a name registered twice is listed once. */
function unique<T extends { name?: string; id?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.name ?? item.id ?? '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildCapabilities(sources: CapabilitySources): Capabilities {
  const tools = unique(sources.voiceTools);
  const groups = GROUP_ORDER.map(id => ({
    id,
    title: GROUP_TITLES[id],
    entries: tools
      .filter(tool => (TOOL_GROUPS[tool.name] ?? 'more') === id)
      .map(tool => ({ name: tool.name, description: shortDescription(tool.description) })),
  })).filter(group => group.entries.length > 0);
  return {
    groups,
    agentActions: unique(sources.agentActions).map(action => ({
      name: action.name,
      description: shortDescription(action.description),
    })),
    places: unique(sources.places),
    settingsSections: unique(sources.settingsSections),
  };
}

/** Every voice tool name in the catalog, in order: for tests and for checking a name exists. */
export function capabilityNames(capabilities: Capabilities): string[] {
  return capabilities.groups.flatMap(group => group.entries.map(entry => entry.name));
}

/**
 * The short version for every prompt: tool names by group and the places that can be opened. The tools' own
 * declarations say how to use them; this says what exists, so the model never says it cannot.
 */
export function compactCapabilities(capabilities: Capabilities): string {
  const lines = capabilities.groups.map(group => `${group.title}: ${group.entries.map(e => e.name).join(', ')}.`);
  if (capabilities.places.length) {
    lines.push(`Places in the side panel (open_place): ${capabilities.places.map(p => p.label).join(', ')}.`);
  }
  if (capabilities.settingsSections.length) {
    lines.push(`Settings sections (open_place): ${capabilities.settingsSections.map(s => s.label).join(', ')}.`);
  }
  return lines.join('\n');
}

/** The whole list, grouped, for what_can_you_do: each tool with what it does, then the chat agent and the panel. */
export function fullCapabilities(capabilities: Capabilities): string {
  const sections = capabilities.groups.map(
    group => `${group.title}:\n${group.entries.map(entry => `- ${entry.name}: ${entry.description}`).join('\n')}`,
  );
  if (capabilities.agentActions.length) {
    sections.push(
      `In a chat (the browser agent, reached with do_task or run_browser_task):\n${capabilities.agentActions
        .map(action => `- ${action.name}: ${action.description}`)
        .join('\n')}`,
    );
  }
  if (capabilities.places.length) {
    sections.push(`Places in the side panel I can open:\n${capabilities.places.map(p => `- ${p.label}`).join('\n')}`);
  }
  if (capabilities.settingsSections.length) {
    sections.push(
      `Settings sections I can open:\n${capabilities.settingsSections.map(s => `- ${s.label}`).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

/** Finds a place or settings section by what the user called it: its id, its label, or words of its label. */
export function findPlace(
  capabilities: Pick<Capabilities, 'places' | 'settingsSections'>,
  spoken: string,
): { kind: 'place' | 'section'; entry: PanelPlaceEntry } | null {
  const words = normalise(spoken);
  if (!words) return null;
  const candidates = [
    ...capabilities.places.map(entry => ({ kind: 'place' as const, entry })),
    ...capabilities.settingsSections.map(entry => ({ kind: 'section' as const, entry })),
  ];
  const said = words.split(' ').filter(word => !STOP_WORDS.has(word));
  // "settings" alone is the Settings place; next to other words it only says where to look ("voice settings")
  const core = said.filter(word => word !== 'settings' && word !== 'section');
  if (core.length === 0) {
    const settings = said.includes('settings') ? candidates.find(c => c.entry.id === 'settings') : undefined;
    return settings ?? null;
  }
  const phrase = core.join(' ');
  const exact = candidates.find(c => normalise(c.entry.id) === phrase || normalise(c.entry.label) === phrase);
  if (exact) return exact;
  const scored = candidates
    .map(c => {
      const haystack = new Set(`${normalise(c.entry.label)} ${normalise(c.entry.id)}`.split(' '));
      const hits = core.filter(word => haystack.has(word) || haystack.has(word.replace(/s$/, ''))).length;
      return { c, hits, size: haystack.size };
    })
    .filter(item => item.hits === core.length)
    // Said "settings": a section first; otherwise places first. Then the shortest label (the closest match)
    .sort(
      (a, b) =>
        (said.includes('settings') ? -1 : 1) * (Number(a.c.kind === 'section') - Number(b.c.kind === 'section')) ||
        a.size - b.size,
    );
  return scored[0]?.c ?? null;
}

const STOP_WORDS = new Set(['the', 'my', 'open', 'go', 'to', 'show', 'me', 'page', 'tab', 'please', 'in']);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[›>&/_-]/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
