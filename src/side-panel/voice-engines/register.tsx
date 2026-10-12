// Registers Settings › Voice engines (WS8, see ../registry.ts). Needs one import line in ../registers.ts, which this
// stream does not own: `import './voice-engines/register';`
import { registerSettingsSection } from '../registry';
import VoiceEngineSettings from './VoiceEngineSettings';

registerSettingsSection({
  id: 'voice-engines',
  label: 'voice_engine_settings_title',
  // Right after Voice output (65)
  order: 66,
  Component: VoiceEngineSettings,
});
