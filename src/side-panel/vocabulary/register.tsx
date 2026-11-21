// Settings › Voice › Vocabulary: the words Ava mishears and how to write them (docs/pm-desk.md, Part 4).
import { registerSettingsSection } from '../registry';
import VocabularySettings from './VocabularySettings';

registerSettingsSection({
  id: 'voice-vocabulary',
  label: 'vocab_section',
  page: 'voice',
  // After the voice and language, before the read-aloud and engines
  order: 1,
  keywords: ['words', 'names', 'spelling', 'dictation', 'misheard', 'correct'],
  Component: VocabularySettings,
});
