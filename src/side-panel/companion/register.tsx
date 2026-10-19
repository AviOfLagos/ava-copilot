// Registers Nex Brain's settings section (see ../registry.ts). Needs one import line in ../registers.ts,
// which this stream does not own: `import './companion/register';`
import { registerSettingsSection } from '../registry';
import BrainSettings from './BrainSettings';

registerSettingsSection({
  id: 'brain',
  label: 'brain_settings_title',
  page: 'connections',
  order: 30,
  keywords: ['mac', 'companion', 'docker', 'pair'],
  Component: BrainSettings,
});
