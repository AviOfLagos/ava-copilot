// Registers Settings › Voice devices (microphone/speaker pickers). Needs one import line in
// ../registers.ts, which this stream does not own: `import './audio-devices/register';`
import { registerSettingsSection } from '../registry';
import AudioDeviceSettings from './AudioDeviceSettings';

registerSettingsSection({
  id: 'audio-devices',
  label: 'audio_device_settings_title',
  // After the engines (20)
  page: 'voice',
  order: 30,
  keywords: ['microphone', 'speaker', 'device', 'headphones'],
  Component: AudioDeviceSettings,
});
