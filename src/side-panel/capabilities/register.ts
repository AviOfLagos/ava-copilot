import { t } from '@extension/i18n';
import { CORE_PROFILE, CORE_TOP } from '../layout/Sidebar';
import { registeredPlaces, registeredSettingsSections } from '../registry';

/**
 * Tells the background which places and settings sections this panel has, in the user's language, so Ava's
 * capability list comes from what is registered here (src/background/capabilities). Sent once at startup, after
 * every register file has run.
 */

type Key = Parameters<typeof t>[0];

// The sections Settings draws itself (src/side-panel/settings/SettingsView.tsx); registered ones follow
const CORE_SETTINGS_SECTIONS: { id: string; label: Key }[] = [
  { id: 'general', label: 'shell_settings_general' },
  { id: 'voice', label: 'settings_voice' },
  { id: 'brief', label: 'settings_brief' },
  { id: 'obsidian', label: 'settings_obsidian' },
  { id: 'agent-behaviour', label: 'shell_settings_agentBehaviour' },
  { id: 'meetings-settings', label: 'settings_meetings' },
  { id: 'calendar', label: 'settings_calendar' },
  { id: 'memory-settings', label: 'settings_memory' },
];

export function panelCatalog() {
  const places = [
    ...CORE_TOP,
    ...registeredPlaces('top').map(place => ({ place: place.id, label: place.label, order: place.order })),
    ...CORE_PROFILE,
    ...registeredPlaces('profile').map(place => ({ place: place.id, label: place.label, order: place.order })),
  ].map(place => ({ id: String(place.place), label: t(place.label) }));
  const settingsSections = [
    ...CORE_SETTINGS_SECTIONS,
    ...registeredSettingsSections().map(section => ({ id: section.id, label: section.label })),
  ].map(section => ({ id: section.id, label: t(section.label) }));
  return { places, settingsSections };
}

setTimeout(() => {
  void chrome.runtime.sendMessage({ type: 'capabilities_panel', catalog: panelCatalog() }).catch(() => {});
});
