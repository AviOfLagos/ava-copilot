// Settings › Voice › Ambient (docs/ambient-plan.md). The header's indicator is drawn by layout/Header.tsx.
import { registerSettingsSection } from '../registry';
import AmbientSettings from './AmbientSettings';

registerSettingsSection({
  id: 'voice-ambient',
  label: 'ambient_section',
  // After the wake word (60)
  page: 'voice',
  order: 65,
  keywords: ['ambient', 'listen', 'scribe', 'transcribe', 'off the record', 'notes', 'always on'],
  Component: AmbientSettings,
});
