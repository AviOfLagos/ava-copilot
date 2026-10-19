// Registers Settings › About you and Settings › Voice and language. "Ava's core" sits inside Settings ›
// Personalities (../personalities/PersonalitiesSettings.tsx), above the list.
import { registerSettingsSection } from '../registry';
import AboutYouSettings from './AboutYouSettings';
import VoiceIdentitySettings from './VoiceIdentitySettings';

registerSettingsSection({
  id: 'about-you',
  label: 'ava_about_title',
  // What Ava knows about you heads Memory
  page: 'memory',
  order: 0,
  keywords: ['facts', 'goals', 'about me', 'identity'],
  Component: AboutYouSettings,
});

registerSettingsSection({
  id: 'voice-identity',
  label: 'ava_voice_section',
  // First on Voice, before Read aloud and the engines
  page: 'voice',
  order: 0,
  keywords: ['language', 'accent', 'voice'],
  Component: VoiceIdentitySettings,
});
