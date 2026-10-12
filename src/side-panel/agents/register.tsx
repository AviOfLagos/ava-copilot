// The agents stream registers its places and settings sections here (see ../registry.ts).
import { Bot } from 'lucide-react';
import { registerPlace } from '../registry';
import AgentsPlace from './AgentsPlace';

registerPlace({
  id: 'agents',
  label: 'agents_place',
  icon: Bot,
  group: 'top',
  order: 50,
  Component: AgentsPlace,
});
