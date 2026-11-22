// "Ava, note a task for Ada" on a call (docs/pm-desk.md Part 6): the after-call list under a meeting's note. The
// live card during the call is mounted once in SidePanel.tsx (CallTaskCards).
import { registerTurnAddon } from '../registry';
import { MeetingCallTasks } from './CallTaskList';

registerTurnAddon('call-tasks', MeetingCallTasks);
