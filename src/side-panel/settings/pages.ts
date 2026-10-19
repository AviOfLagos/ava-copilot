import type { t } from '@extension/i18n';
import type { SettingsPageId, SettingsSectionDefinition } from '../registry';

/**
 * The pages of the full-page Settings (options.html), in nav order, and its routes: `#voice` opens a page,
 * `#voice/engines` opens it at a section (the section's id without the page prefix, or its whole id). The panel
 * and the background build the same links from here, so a deep link means the same thing everywhere.
 */

type MessageKey = Parameters<typeof t>[0];

export interface SettingsPage {
  id: SettingsPageId;
  label: MessageKey;
  hint: MessageKey;
}

export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', label: 'settings_page_general', hint: 'settings_page_general_hint' },
  { id: 'models', label: 'settings_page_models', hint: 'settings_page_models_hint' },
  { id: 'voice', label: 'settings_page_voice', hint: 'settings_page_voice_hint' },
  { id: 'personalities', label: 'settings_page_personalities', hint: 'settings_page_personalities_hint' },
  { id: 'memory', label: 'settings_page_memory', hint: 'settings_page_memory_hint' },
  { id: 'connections', label: 'settings_page_connections', hint: 'settings_page_connections_hint' },
  { id: 'meetings', label: 'settings_page_meetings', hint: 'settings_page_meetings_hint' },
  { id: 'privacy', label: 'settings_page_privacy', hint: 'settings_page_privacy_hint' },
  { id: 'help', label: 'settings_page_help', hint: 'settings_page_help_hint' },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'general';

export function isSettingsPage(value: string): value is SettingsPageId {
  return SETTINGS_PAGES.some(page => page.id === value);
}

/** The section's part of the hash: `voice-engines` on Voice is `engines`. */
export function sectionSlug(section: Pick<SettingsSectionDefinition, 'id' | 'page'>): string {
  const prefix = `${section.page}-`;
  return section.id.startsWith(prefix) && section.id.length > prefix.length
    ? section.id.slice(prefix.length)
    : section.id;
}

export interface SettingsRoute {
  page: SettingsPageId;
  // What came after the page: a section's slug or id, or something the page's first section understands
  anchor: string | null;
}

/** Reads `#voice/engines` (an unknown page is General; the leading # is optional). */
export function parseSettingsHash(hash: string): SettingsRoute {
  const [page = '', ...rest] = decodeURIComponent(hash.replace(/^#/, ''))
    .split('/')
    .map(part => part.trim());
  const anchor = rest.filter(Boolean).join('/') || null;
  return isSettingsPage(page) ? { page, anchor } : { page: DEFAULT_SETTINGS_PAGE, anchor: null };
}

export function settingsHash(page: SettingsPageId, anchor?: string | null): string {
  return anchor ? `#${page}/${anchor}` : `#${page}`;
}

/** The section of the page an anchor names, by slug or id. */
export function sectionForAnchor<T extends Pick<SettingsSectionDefinition, 'id' | 'page'>>(
  sections: T[],
  anchor: string | null,
): T | null {
  if (!anchor) return null;
  const head = anchor.split('/')[0];
  return sections.find(section => sectionSlug(section) === head || section.id === head) ?? null;
}

/** The hash that opens a section on its page. */
export function sectionHash(section: Pick<SettingsSectionDefinition, 'id' | 'page'>): string {
  return settingsHash(section.page, sectionSlug(section));
}

/** Whether a section matches every word of a search, by its label, its page's name, or its keywords. */
export function sectionMatches(words: string[], texts: string[]): boolean {
  if (!words.length) return true;
  const haystack = texts.join(' ').toLowerCase();
  return words.every(word => haystack.includes(word));
}

export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
