// Registers Settings › Personalities (see ../registry.ts). The header's quick switch lives in ../layout/Header.tsx.
import { registerSettingsSection } from '../registry';
import PersonalitiesSettings from './PersonalitiesSettings';

registerSettingsSection({
  id: 'personalities',
  label: 'persona_settings_title',
  // Its own page: it shapes every answer
  page: 'personalities',
  order: 0,
  keywords: ['personality', 'tone', 'core', 'voice'],
  Component: PersonalitiesSettings,
});
