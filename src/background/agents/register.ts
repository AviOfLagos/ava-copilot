// The agents stream registers its commands, jobs, agent actions, voice tools and recovery here
// (see ../registry and ../jobs/runner).
import { db } from '@extension/storage';
import type { InboxItem } from '@extension/storage';
import { registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerRecovery } from '../registry';
import { registerStepExecutor } from '../workflows/executors';
import { registerAgentActions } from './actions';
import { BUS_JOB } from './bus';
import { registerAgentCommands } from './commands';
import { HANDOFF_POST_JOB } from './handoff';
import { agentService, agentWindow, handoffService } from './instance';
import { AGENT_RETENTION_JOB, AGENT_RUN_JOB, AGENT_SCHEDULE_JOB } from './service';
import { registerHandoff } from './team';
import { registerAgentVoiceTools } from './voice';
import { agentStepExecutor } from './workflow-step';

const logger = createLogger('Agents');

registerAgentCommands(agentService);
registerAgentActions(agentService);
registerAgentVoiceTools(agentService);
// Ava hands work to the agent that owns it (hand_to_agent), and the answer comes back to the chat
registerHandoff(handoffService);
// A routine's step.agent runs one of the user's agents
registerStepExecutor('step.agent', agentStepExecutor(agentService, db));

registerJobHandler(AGENT_SCHEDULE_JOB, job => agentService.fireSchedule(job));
registerJobHandler(AGENT_RUN_JOB, job => agentService.wake(job));
registerJobHandler(BUS_JOB, async job => {
  const payload = job.payload as { messageId?: string; attempt?: number } | null;
  if (payload?.messageId) await agentService.bus.deliverPending(payload.messageId, payload.attempt ?? 0);
});
registerJobHandler(AGENT_RETENTION_JOB, () => agentService.retention());
registerJobHandler(HANDOFF_POST_JOB, async job => {
  const runId = (job.payload as { runId?: string } | null)?.runId;
  if (runId) await handoffService.deliver(runId);
});
registerRecovery('agents', () => agentService.recover());
// After the runs: answers of hand-offs that ended while the background was away go back to their chats
registerRecovery('agents-handoff', () => handoffService.recover());

// Pages the user opens wake the agents (and routines) watching them; never a private window or the agents' own
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  void agentService.onTabUpdated(tab, change).catch(error => logger.warning('Tab watch failed', error));
});
chrome.tabs.onRemoved.addListener(tabId => agentService.onTabRemoved(tabId));
// The user closed the agents' window: the next run opens a new one
chrome.windows.onRemoved.addListener(windowId => void agentWindow.forget(windowId).catch(() => {}));

// A new Inbox item wakes the agents listening for one (after its write is done, and only if it was kept)
db.inbox.hook('creating', (_key: unknown, item: InboxItem) => {
  const copy = { ...item };
  setTimeout(() => {
    void db.inbox
      .get(copy.id)
      .then(stored => (stored ? agentService.onInboxItem(stored) : 0))
      .catch(error => logger.warning('Inbox trigger failed', error));
  });
});

// A meeting the user took notes of ends: the agents listening for it (meeting follow-ups) get its notes as data
db.meetings.hook('updating', (changes: Partial<{ status: string }>, meetingId: string) => {
  if (changes.status !== 'done') return;
  setTimeout(() => {
    void db.meetings
      .get(meetingId)
      .then(meeting => (meeting?.status === 'done' ? agentService.onMeetingEnded(meeting) : 0))
      .catch(error => logger.warning('Meeting trigger failed', error));
  });
});
