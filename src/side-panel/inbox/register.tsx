// The inbox stream registers its places and settings sections here (see ../registry.ts).
import { Inbox } from 'lucide-react';
import { registerPlace, registerSettingsSection } from '../registry';
import InboxPlace from './InboxPlace';
import InboxSettingsSection from './InboxSettingsSection';

registerPlace({
  id: 'inbox',
  label: 'inbox_title',
  icon: Inbox,
  group: 'top',
  order: 10,
  Component: InboxPlace,
});

registerSettingsSection({
  id: 'inbox',
  label: 'inbox_settings_title',
  order: 45,
  Component: InboxSettingsSection,
});
