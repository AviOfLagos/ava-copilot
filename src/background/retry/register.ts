import { db, threadStore } from '@extension/storage';
import { agentSpend } from '../agents/budget';
import { addInboxItem, markDone } from '../inbox/store';
import { jobs, registerJobHandler } from '../jobs/runner';
import { emitNotice } from '../notices';
import { services } from '../registry/services';
import { RunEndings, THREAD_RETRY_JOB } from './endings';

/**
 * Failed tasks retry, then report (docs/growth-team.md, Part 2). The thread manager is given `runEndings` when
 * the background starts (src/background/index.ts); the job runner calls the handler below when a try is due.
 */
export const runEndings = new RunEndings({
  schedule: request => jobs.schedule(request),
  cancelJob: key => jobs.cancel(key),
  inbox: draft => addInboxItem(draft),
  inboxItem: id => db.inbox.get(id),
  settleInbox: id => markDone(id),
  notice: emitNotice,
  note: (threadId, text) => threadStore.addMessage(threadId, 'system', text),
  agent: agentId => db.agents.get(agentId),
  agentSpentUsd: async agentId => (await agentSpend(db, agentId)).costUsd,
  now: Date.now,
});

registerJobHandler(THREAD_RETRY_JOB, job => {
  const threads = services().threads;
  return runEndings.runRetry(job, {
    thread: threadId => threadStore.get(threadId),
    resume: threadId => threads.continueThread(threadId, undefined, { auto: true }),
    postpone: (threadId, retryAt) => threads.postponeRetry(threadId, retryAt),
    giveUp: threadId => threads.giveUpRetry(threadId),
  });
});
