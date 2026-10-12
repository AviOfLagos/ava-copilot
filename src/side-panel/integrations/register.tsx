// The integrations stream registers its places and settings sections here (see ../registry.ts).
import { Plug } from 'lucide-react';
import { registerPlace } from '../registry';
import ConnectorsPlace from './ConnectorsPlace';

registerPlace({
  id: 'connectors',
  label: 'conn_place',
  icon: Plug,
  group: 'profile',
  order: 20,
  Component: ConnectorsPlace,
});
