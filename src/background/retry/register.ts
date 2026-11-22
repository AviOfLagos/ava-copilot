import { db, threadStore } from '@extension/storage';
import type { AgentTaskState } from '@extension/storage';
import { agentSpend } from '../agents/budget';
import { addInboxItem, markDone, markUnread } from '../inbox/store';
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
  cancelJobs: async prefix => {
    const keys = await db.jobs.where('key').startsWith(prefix).primaryKeys();
    const found = await db.jobs.bulkGet(keys);
    for (const job of found) if (job) await jobs.cancel(job.key);
  },
  inbox: draft => addInboxItem(draft),
  inboxItem: id => db.inbox.get(id),
  settleInbox: id => markDone(id),
  reopenInbox: id => markUnread(id),
  // An agent's chat is followed while a run of its agent that works in it is still open
  ownerFollows: async thread => {
    if (!thread.agentId) return true;
    const open = await db.runs
      .where('agentId')
      .equals(thread.agentId)
      .filter(run => run.status === 'running' || run.status === 'waiting_user')
      .toArray();
    for (const run of open) {
      const steps = await db.runSteps.where('runId').equals(run.id).toArray();
      if (steps.some(step => (step.state as AgentTaskState | null)?.threadId === thread.id)) return true;
    }
    return false;
  },
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
    drop: threadId => threads.dropRetry(threadId),
  });
});
