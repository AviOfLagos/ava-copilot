// Registers the chat stream's settings section (see ../registry.ts). Needs one import line from
// ../registers.ts, which this stream does not own: `import './chat/register';`
import { registerSettingsSection } from '../registry';
import TtsSettingsSection from './TtsSettingsSection';

registerSettingsSection({
  id: 'tts',
  label: 'speak_settings_title',
  page: 'voice',
  order: 10,
  keywords: ['read aloud', 'speak', 'text to speech', 'tts', 'kitten', 'kokoro'],
  Component: TtsSettingsSection,
});
