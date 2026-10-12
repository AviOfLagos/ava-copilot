// The models stream registers its place here (see ../registry.ts). The lead imports this file from
// ../registers.ts.
import { Cpu } from 'lucide-react';
import { registerPlace } from '../registry';
import ModelsPage from './ModelsPage';

registerPlace({
  id: 'models',
  group: 'profile',
  order: 40,
  label: 'models_title',
  icon: Cpu,
  Component: ModelsPage,
});
