// The account stream registers its places and settings sections here (see ../registry.ts).
// `registers.ts` (shared, not ours to edit) only imports this file for our stream, so every place
// WS1 registers — not only "account" ones — goes through here.
import { Layers, Sparkles } from 'lucide-react';
import { registerPlace } from '../registry';
import WorkspacesPlace from '../workspaces/WorkspacesPlace';
import SkillsPlace from '../skills/SkillsPlace';

// Order within the profile menu: Knowledge base(0), Workspaces(10), [Connectors(20)], Skills(30),
// [Models & usage(40)], Settings(50), How do I…(60) — the bracketed ones are other streams' places.
registerPlace({
  id: 'workspaces',
  label: 'settings_workspaces',
  icon: Layers,
  group: 'profile',
  order: 10,
  Component: WorkspacesPlace,
});
registerPlace({
  id: 'skills',
  label: 'options_skills_header',
  icon: Sparkles,
  group: 'profile',
  order: 30,
  Component: SkillsPlace,
});
