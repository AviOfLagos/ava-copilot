// "Bring in your AI history" in Settings (see ../registry.ts)
import { registerSettingsSection } from '../registry';
import HistorySettings from './HistorySettings';

registerSettingsSection({
  id: 'history',
  label: 'history_section',
  order: 15,
  Component: HistorySettings,
});
