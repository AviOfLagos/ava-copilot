// Registers Settings › Voice engines (WS8, see ../registry.ts). Needs one import line in ../registers.ts, which this
// stream does not own: `import './voice-engines/register';`
import { registerSettingsSection } from '../registry';
import VoiceEngineSettings from './VoiceEngineSettings';
import VoiceHealthPanel from './VoiceHealthPanel';
import VoicePresets from './VoicePresets';

// This computer's speed and the presets built on it, above the engines they set
registerSettingsSection({
  id: 'voice-presets',
  label: 'voice_preset_title',
  page: 'voice',
  order: 15,
  keywords: ['preset', 'check this computer', 'speed', 'slow', 'pause', 'lag', 'recommended', 'kitten', 'kokoro'],
  Component: VoicePresets,
});

registerSettingsSection({
  id: 'voice-engines',
  label: 'voice_engine_settings_title',
  // Hearing and the engines, after Read aloud (10)
  page: 'voice',
  order: 20,
  keywords: ['speech to text', 'stt', 'moonshine', 'whisper', 'economy', 'live', 'engine'],
  Component: VoiceEngineSettings,
});

// What went wrong lately, found from measured times, with the report that goes into an issue
registerSettingsSection({
  id: 'voice-health',
  label: 'voice_health_title',
  page: 'voice',
  order: 25,
  keywords: ['diagnose', 'problem', 'slow', 'pause', 'report', 'issue', 'trace', 'lag'],
  Component: VoiceHealthPanel,
});
