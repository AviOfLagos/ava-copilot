// The settings sections Settings itself owns, one component per setting, registered like every stream's so the
// full-page Settings (src/options) and Ava's list of sections come from one registry. Other streams register their
// own sections (personalities, voice engines, Ava Brain…) with a `page` from ../registry.ts.
import { registerSettingsSection } from '../registry';
import { ConnectorsSection, CalendarSection, ObsidianSection } from './sections/ConnectionSections';
import {
  AgentLimitsSection,
  ConfirmSection,
  DailyCapSection,
  PermissionsSection,
  HighlightsSection,
  NamesSection,
  ThemeSection,
  WritingStyleSection,
} from './sections/GeneralSections';
import { BriefSection, MeetingsSection } from './sections/MeetingSections';
import { AgentMemorySection, MemoryDataSection, MemoryIndexSection } from './sections/MemorySections';
import {
  FirewallSection,
  TracingSection,
  HelpTasksSection,
  InstallOverviewSection,
  ModelsSection,
  SkillsSection,
} from './sections/OtherSections';
import { TurnPatienceSection, WakeWordSection } from './sections/VoiceSections';

// General
registerSettingsSection({
  id: 'names',
  label: 'settings_section_names',
  page: 'general',
  order: 0,
  keywords: ['name', 'assistant', 'ava', 'wake'],
  Component: NamesSection,
});
registerSettingsSection({
  id: 'theme',
  label: 'settings_look',
  page: 'general',
  order: 10,
  keywords: ['theme', 'dark', 'light', 'appearance'],
  Component: ThemeSection,
});
registerSettingsSection({
  id: 'writing',
  label: 'settings_writing',
  page: 'general',
  order: 20,
  keywords: ['style', 'tone', 'prompt'],
  Component: WritingStyleSection,
});
registerSettingsSection({
  id: 'confirm',
  label: 'options_gate_header',
  page: 'general',
  order: 30,
  keywords: ['confirm', 'ask', 'send', 'delete', 'gate', 'approve'],
  Component: ConfirmSection,
});
registerSettingsSection({
  id: 'permissions',
  label: 'settings_permissions',
  page: 'general',
  order: 31,
  keywords: ['permission', 'allow', 'always', 'every time', 'confirm', 'rule'],
  Component: PermissionsSection,
});
registerSettingsSection({
  id: 'cap',
  label: 'settings_spending',
  page: 'general',
  order: 40,
  keywords: ['cost', 'cap', 'budget', 'money', 'spend'],
  Component: DailyCapSection,
});
registerSettingsSection({
  id: 'highlights',
  label: 'settings_section_highlights',
  page: 'general',
  order: 50,
  keywords: ['highlight', 'boxes', 'click'],
  Component: HighlightsSection,
});
registerSettingsSection({
  id: 'agent',
  label: 'settings_section_agent',
  page: 'general',
  order: 60,
  keywords: ['steps', 'actions', 'failures', 'vision', 'planning', 'replay', 'browser agent'],
  Component: AgentLimitsSection,
});

// Models
registerSettingsSection({
  id: 'models',
  label: 'models_title',
  page: 'models',
  order: 0,
  bare: true,
  keywords: ['provider', 'key', 'api', 'ollama', 'lm studio', 'local', 'roles', 'usage', 'fallback', 'gemini'],
  Component: ModelsSection,
});

// Voice
registerSettingsSection({
  id: 'wake',
  label: 'settings_section_wake',
  page: 'voice',
  order: 60,
  keywords: ['wake word', 'hey', 'listen', 'vosk'],
  Component: WakeWordSection,
});
registerSettingsSection({
  id: 'patience',
  label: 'settings_section_patience',
  page: 'voice',
  order: 61,
  keywords: ['patience', 'pause', 'interrupt', 'cut in', 'turn', 'wait', 'think'],
  Component: TurnPatienceSection,
});

// Memory
registerSettingsSection({
  id: 'memory-index',
  label: 'settings_section_memoryIndex',
  page: 'memory',
  order: 20,
  keywords: ['knowledge', 'index', 'graph', 'embed', 'retention', 'search'],
  Component: MemoryIndexSection,
});
registerSettingsSection({
  id: 'memory-agents',
  label: 'settings_section_agentMemory',
  page: 'memory',
  order: 30,
  keywords: ['private', 'team', 'agent'],
  Component: AgentMemorySection,
});
registerSettingsSection({
  id: 'memory-data',
  label: 'settings_section_memoryData',
  page: 'memory',
  order: 40,
  keywords: ['export', 'import', 'wipe', 'backup'],
  Component: MemoryDataSection,
});

// Connections
registerSettingsSection({
  id: 'connectors',
  label: 'conn_place',
  page: 'connections',
  order: 0,
  keywords: ['mcp', 'connector', 'gmail', 'drive'],
  Component: ConnectorsSection,
});
registerSettingsSection({
  id: 'obsidian',
  label: 'settings_obsidian',
  page: 'connections',
  order: 10,
  keywords: ['vault', 'notes', 'folder', 'brave'],
  Component: ObsidianSection,
});
registerSettingsSection({
  id: 'calendar',
  label: 'settings_calendar',
  page: 'connections',
  order: 20,
  keywords: ['ical', 'google calendar', 'reminders'],
  Component: CalendarSection,
});

// Meetings & brief
registerSettingsSection({
  id: 'meetings',
  label: 'settings_meetings',
  page: 'meetings',
  order: 0,
  keywords: ['notes', 'captions', 'microphone', 'audio', 'call'],
  Component: MeetingsSection,
});
registerSettingsSection({
  id: 'brief',
  label: 'settings_brief',
  page: 'meetings',
  order: 10,
  keywords: ['morning', 'brief', 'priorities'],
  Component: BriefSection,
});

// Privacy & safety
registerSettingsSection({
  id: 'firewall',
  label: 'options_tabs_firewall',
  page: 'privacy',
  order: 0,
  bare: true,
  keywords: ['blocked', 'allowed', 'sites', 'firewall'],
  Component: FirewallSection,
});
registerSettingsSection({
  id: 'skills',
  label: 'options_skills_header',
  page: 'privacy',
  order: 10,
  bare: true,
  keywords: ['skills', 'playbook', 'markdown'],
  Component: SkillsSection,
});
registerSettingsSection({
  id: 'tracing',
  label: 'settings_tracing_title',
  page: 'privacy',
  order: 20,
  keywords: ['tracing', 'suture', 'telemetry', 'hosted', 'diagnostics'],
  Component: TracingSection,
});

// Help
registerSettingsSection({
  id: 'help-install',
  label: 'settings_install_title',
  page: 'help',
  order: 0,
  keywords: ['install', 'download', 'model', 'setup'],
  Component: InstallOverviewSection,
});
registerSettingsSection({
  id: 'help-tasks',
  label: 'nav_help',
  page: 'help',
  order: 10,
  keywords: ['how do i', 'help'],
  Component: HelpTasksSection,
});
