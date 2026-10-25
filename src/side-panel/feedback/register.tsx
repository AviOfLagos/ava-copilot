// Settings › Help › Report a problem: GitHub issue forms with the version and browser filled in
import { registerSettingsSection } from '../registry';
import FeedbackSection from './FeedbackSection';

registerSettingsSection({
  id: 'help-feedback',
  label: 'feedback_title',
  page: 'help',
  order: -5,
  keywords: ['feedback', 'bug', 'report', 'problem', 'issue', 'idea', 'github'],
  Component: FeedbackSection,
});
