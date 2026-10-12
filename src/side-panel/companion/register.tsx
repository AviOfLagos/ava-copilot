// Registers Avi Brain's settings section (see ../registry.ts). Needs one import line in ../registers.ts,
// which this stream does not own: `import './companion/register';`
import { registerSettingsSection } from '../registry';
import BrainSettings from './BrainSettings';

registerSettingsSection({
  id: 'brain',
  label: 'brain_settings_title',
  order: 70,
  Component: BrainSettings,
});
