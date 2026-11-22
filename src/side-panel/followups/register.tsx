// Follow-ups (docs/pm-desk.md, Part 9): the "Mark done?" questions under a meeting's note.
import { registerTurnAddon } from '../registry';
import { MeetingMarkDone } from './MarkDoneOffers';

registerTurnAddon('followups-markdone', MeetingMarkDone);
