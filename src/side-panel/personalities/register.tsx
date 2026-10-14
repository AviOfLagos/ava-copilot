// Registers Settings › Personalities (see ../registry.ts). The header's quick switch lives in ../layout/Header.tsx.
import { registerSettingsSection } from '../registry';
import PersonalitiesSettings from './PersonalitiesSettings';

registerSettingsSection({
  id: 'personalities',
  label: 'persona_settings_title',
  // First of the registered sections: it shapes every answer
  order: 10,
  Component: PersonalitiesSettings,
});
