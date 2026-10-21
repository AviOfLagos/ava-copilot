// Registers Settings › Memory › Backups (see ../registry.ts), imported from ../registers.ts.
import { registerSettingsSection } from '../registry';
import BackupsSection from './BackupsSection';

registerSettingsSection({
  id: 'memory-backups',
  label: 'backup_section',
  page: 'memory',
  order: 35,
  keywords: ['backup', 'restore', 'reinstall', 'uninstall', 'mac', 'nex brain', 'keychain'],
  Component: BackupsSection,
});
