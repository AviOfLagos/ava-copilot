// Registers Settings › Help's "Updates" section (see ../registry.ts). Needs one import line in ../registers.ts:
// `import './update/register';`
import { registerSettingsSection } from '../registry';
import UpdateSettings from './UpdateSettings';

registerSettingsSection({
  id: 'help-updates',
  label: 'update_settings_title',
  page: 'help',
  order: -10,
  keywords: ['update', 'version', 'changelog', 'release', 'upgrade', 'nex brain', "what's new"],
  Component: UpdateSettings,
});
