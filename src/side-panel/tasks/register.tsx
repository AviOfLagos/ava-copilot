// The task board's place in the drawer (docs/pm-desk.md, Part 2.4; see ../registry.ts).
import { ListChecks } from 'lucide-react';
import { registerPlace } from '../registry';
import TasksPlace from './TasksPlace';

registerPlace({
  id: 'tasks',
  label: 'tasks_title',
  icon: ListChecks,
  group: 'top',
  order: 15,
  Component: TasksPlace,
});
