// The setup checklist's place in Settings: the first section of General, so the header's dot and the toolbar badge
// land on it (options.html#general/setup).
import { registerSettingsSection } from '../registry';
import type { PanelApi } from '../registry';
import SetupChecklist from './SetupChecklist';

function SetupSection({ api }: { api: PanelApi }) {
  return <SetupChecklist api={api} />;
}

registerSettingsSection({
  id: 'setup',
  label: 'setup_title',
  page: 'general',
  order: -10,
  keywords: ['setup', 'checklist', 'ollama', 'nex brain', 'voice models', 'whatsapp', 'calendar', 'obsidian', 'backup'],
  Component: SetupSection,
});
