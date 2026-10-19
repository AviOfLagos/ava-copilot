// "Bring in your AI history" in Settings (see ../registry.ts)
import { registerSettingsSection } from '../registry';
import HistorySettings from './HistorySettings';

registerSettingsSection({
  id: 'history',
  label: 'history_section',
  page: 'memory',
  order: 10,
  keywords: ['chatgpt', 'claude', 'import', 'history'],
  Component: HistorySettings,
});
