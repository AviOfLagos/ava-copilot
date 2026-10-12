// The workflows stream registers its places and settings sections here (see ../registry.ts).
import { Workflow } from 'lucide-react';
import { registerPlace } from '../registry';
import WorkflowsPlace from './WorkflowsPlace';

registerPlace({
  id: 'workflows',
  label: 'flow_place',
  icon: Workflow,
  group: 'top',
  order: 40,
  Component: WorkflowsPlace,
});
