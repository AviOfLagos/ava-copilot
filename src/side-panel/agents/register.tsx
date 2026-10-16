// The agents stream registers its places and settings sections here (see ../registry.ts).
import { Bot } from 'lucide-react';
import { registerPlace, registerTurnAddon } from '../registry';
import AgentsPlace from './AgentsPlace';
import HandoffCards from './HandoffCard';

registerPlace({
  id: 'agents',
  label: 'agents_place',
  icon: Bot,
  group: 'top',
  order: 50,
  Component: AgentsPlace,
});

// A chat that handed work to an agent shows where it stands, under the turn that handed it over
registerTurnAddon('agents-handoff', HandoffCards);
