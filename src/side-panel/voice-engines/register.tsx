// Registers Settings › Voice engines (WS8, see ../registry.ts). Needs one import line in ../registers.ts, which this
// stream does not own: `import './voice-engines/register';`
import { registerSettingsSection } from '../registry';
import VoiceEngineSettings from './VoiceEngineSettings';

registerSettingsSection({
  id: 'voice-engines',
  label: 'voice_engine_settings_title',
  // Hearing and the engines, after Read aloud (10)
  page: 'voice',
  order: 20,
  keywords: ['speech to text', 'stt', 'moonshine', 'whisper', 'economy', 'live', 'engine'],
  Component: VoiceEngineSettings,
});
