import { describe, expect, it } from 'vitest';
import { registerSettingsSection, registeredSettingsSections } from '../../registry';
import {
  DEFAULT_SETTINGS_PAGE,
  parseSettingsHash,
  searchWords,
  sectionForAnchor,
  sectionHash,
  sectionMatches,
  sectionSlug,
  settingsHash,
} from '../pages';

const Nothing = () => null;

describe('settings registry pages', () => {
  registerSettingsSection({
    id: 'voice-engines',
    label: 'settings_page_voice',
    page: 'voice',
    order: 20,
    Component: Nothing,
  });
  registerSettingsSection({ id: 'tts', label: 'settings_page_voice', page: 'voice', order: 10, Component: Nothing });
  registerSettingsSection({
    id: 'names',
    label: 'settings_page_general',
    page: 'general',
    order: 0,
    Component: Nothing,
  });

  it('lists a page’s sections only, in order', () => {
    expect(registeredSettingsSections('voice').map(section => section.id)).toEqual(['tts', 'voice-engines']);
    expect(registeredSettingsSections('general').map(section => section.id)).toEqual(['names']);
    expect(registeredSettingsSections('help')).toEqual([]);
  });

  it('lists every section without a page', () => {
    expect(registeredSettingsSections().map(section => section.id)).toEqual(['names', 'tts', 'voice-engines']);
  });
});

describe('settings routes', () => {
  it('reads a page and a section from the hash', () => {
    expect(parseSettingsHash('#voice/engines')).toEqual({ page: 'voice', anchor: 'engines' });
    expect(parseSettingsHash('voice')).toEqual({ page: 'voice', anchor: null });
    expect(parseSettingsHash('#models/local/extra')).toEqual({ page: 'models', anchor: 'local/extra' });
  });

  it('lands on General for an empty or unknown page', () => {
    expect(parseSettingsHash('')).toEqual({ page: DEFAULT_SETTINGS_PAGE, anchor: null });
    expect(parseSettingsHash('#nowhere/engines')).toEqual({ page: 'general', anchor: null });
  });

  it('builds the hash back', () => {
    expect(settingsHash('voice')).toBe('#voice');
    expect(settingsHash('voice', 'engines')).toBe('#voice/engines');
  });

  it('drops the page prefix from a section’s slug, and keeps other ids', () => {
    expect(sectionSlug({ id: 'voice-engines', page: 'voice' })).toBe('engines');
    expect(sectionSlug({ id: 'audio-devices', page: 'voice' })).toBe('audio-devices');
    expect(sectionSlug({ id: 'voice-', page: 'voice' })).toBe('voice-');
    expect(sectionHash({ id: 'memory-index', page: 'memory' })).toBe('#memory/index');
  });

  it('finds the section an anchor names, by slug or whole id', () => {
    const sections = [
      { id: 'tts', page: 'voice' as const },
      { id: 'voice-engines', page: 'voice' as const },
    ];
    expect(sectionForAnchor(sections, 'engines')?.id).toBe('voice-engines');
    expect(sectionForAnchor(sections, 'voice-engines')?.id).toBe('voice-engines');
    expect(sectionForAnchor(sections, 'engines/more')?.id).toBe('voice-engines');
    expect(sectionForAnchor(sections, 'local')).toBeNull();
    expect(sectionForAnchor(sections, null)).toBeNull();
  });
});

describe('settings search', () => {
  it('matches every word against the label, the page and the keywords', () => {
    const texts = ['Voice engines', 'Voice', 'speech to text', 'whisper'];
    expect(sectionMatches(searchWords('whisper'), texts)).toBe(true);
    expect(sectionMatches(searchWords('Voice  SPEECH'), texts)).toBe(true);
    expect(sectionMatches(searchWords('voice calendar'), texts)).toBe(false);
    expect(sectionMatches([], texts)).toBe(true);
  });
});
