// Registers Settings › General's "Rounds and check-ins" section (see ../registry.ts).
import { registerSettingsSection } from '../registry';
import RoundsSettings from './RoundsSettings';

registerSettingsSection({
  id: 'general-rounds',
  label: 'rounds_settings_title',
  page: 'general',
  order: 60,
  keywords: ['rounds', 'check-in', 'offer', 'pulse', 'mail', 'stuck', 'proactive', 'digest'],
  Component: RoundsSettings,
});
