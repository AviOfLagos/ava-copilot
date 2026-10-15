// Registers Settings › About you and Settings › Voice and language. "Ava's core" sits inside Settings ›
// Personalities (../personalities/PersonalitiesSettings.tsx), above the list.
import { registerSettingsSection } from '../registry';
import AboutYouSettings from './AboutYouSettings';
import VoiceIdentitySettings from './VoiceIdentitySettings';

registerSettingsSection({
  id: 'about-you',
  label: 'ava_about_title',
  // Right after Personalities (10): who Ava is, then what she knows about you
  order: 11,
  Component: AboutYouSettings,
});

registerSettingsSection({
  id: 'voice-identity',
  label: 'ava_voice_section',
  // Before Voice output (65) and Voice engines (66)
  order: 64,
  Component: VoiceIdentitySettings,
});
