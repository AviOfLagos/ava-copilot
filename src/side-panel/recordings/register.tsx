// Screen recordings for a task (docs/pm-desk.md, Part 7): the setting for how long one may run.
import { registerSettingsSection } from '../registry';
import RecordingSettings from './RecordingSettings';

registerSettingsSection({
  id: 'meetings-recordings',
  label: 'recording_settings_title',
  page: 'meetings',
  order: 40,
  keywords: ['screen', 'recording', 'video', 'record', 'drive'],
  Component: RecordingSettings,
});
