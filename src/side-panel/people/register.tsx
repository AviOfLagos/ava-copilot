// People (docs/pm-desk.md Part 5): the People page and the "Who's who" card under a meeting's note.
import { Users } from 'lucide-react';
import { registerPlace, registerTurnAddon } from '../registry';
import PeoplePlace from './PeoplePlace';
import { MeetingWhosWho } from './WhosWho';

registerPlace({
  id: 'people',
  label: 'people_title',
  icon: Users,
  group: 'top',
  order: 15,
  Component: PeoplePlace,
});

registerTurnAddon('people-whoswho', MeetingWhosWho);
