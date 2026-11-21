import { expect, vi } from 'vitest';
import { db, emptyProductProfile, productStore, teamStore } from '@extension/storage';
import type { ProductProfile } from '@extension/storage';
import { requestBetaGrant } from '@src/background/growth-team/lead/actions';
import { NO_FACTS } from '@src/background/growth-team/lead/priority';
import { sortFeedback } from '@src/background/growth-team/lead/feedback';
import type { LeadDeps } from '@src/background/growth-team/lead/feedback';
import { resultText } from '@src/background/growth-team/queue';
import type { LeadCase } from './cases';

const WORKSPACE = 'eval-product';
const WHO = { workspaceId: WORKSPACE, agentId: 'growth-lead', agentName: 'Growth Lead' };
// A fixed morning, so the day's limits count the same on every run
const NOW = Date.parse('2026-11-23T09:00:00Z');

/**
 * The Growth Lead's recorded tool calls through the code that acts on them. A recorded call cannot show the model
 * sorts well; it shows that what it decided is kept to the rules: the priority comes from the rule, one issue per
 * feedback, the third ask opens a feature issue, a customer's details never reach an issue, and a beta place past
 * the product's rule is refused.
 */
export async function runLeadCase(evalCase: LeadCase): Promise<void> {
  await Promise.all([db.teamItems, db.teamLedger, db.teamFeedback].map(table => table.clear()));
  const profile: ProductProfile = {
    ...emptyProductProfile({ id: WORKSPACE, name: 'Eval product' }),
    repo: 'example/eval-product',
    superAdmin: { url: 'https://admin.example.com', account: 'owner' },
    betaRule: evalCase.beta?.rule ?? null,
  };
  const forWorkspace = vi
    .spyOn(productStore, 'forWorkspace')
    .mockImplementation(async id => (id === WORKSPACE ? profile : undefined));
  const remaining = evalCase.beta?.remaining;
  const deps: LeadDeps = {
    now: () => NOW,
    publish: async () => undefined,
    remoteGrants: async () => (remaining === undefined ? null : { remaining }),
  };
  try {
    expect(evalCase.expect.steps, 'one expectation per replayed call').toHaveLength(evalCase.replay.length);
    for (const [index, call] of evalCase.replay.entries()) {
      const want = evalCase.expect.steps[index]!;
      let state: string;
      let text: string;
      if (call.tool === 'sort_feedback') {
        const facts = call.facts;
        const result = await sortFeedback(
          profile,
          WHO,
          {
            feedbackId: call.feedback_id,
            sort: call.sort,
            title: call.title,
            summary: call.summary,
            topic: call.topic,
            facts: {
              dataLoss: facts.data_loss ?? NO_FACTS.dataLoss,
              security: facts.security ?? NO_FACTS.security,
              cannotSignIn: facts.cannot_sign_in ?? NO_FACTS.cannotSignIn,
              paymentBroken: facts.payment_broken ?? NO_FACTS.paymentBroken,
              mainFlowBroken: facts.main_flow_broken ?? NO_FACTS.mainFlowBroken,
              payingCustomer: facts.paying_customer ?? NO_FACTS.payingCustomer,
              usersAffected: facts.users_affected ?? NO_FACTS.usersAffected,
              hasWorkaround: facts.has_workaround ?? NO_FACTS.hasWorkaround,
            },
          },
          deps,
        );
        state = result.state;
        text = result.state === 'refused' ? result.why : result.text;
      } else {
        const result = await requestBetaGrant(profile, WHO, { requestId: call.request_id, why: call.why }, deps);
        state = result.state === 'refused' ? 'refused' : 'queued';
        text = resultText(result);
      }
      expect(state, `call ${index + 1} (${call.tool}): ${text}`).toBe(want.state);
      for (const source of want.matches ?? []) expect(text, `call ${index + 1}`).toMatch(new RegExp(source, 'i'));
    }
    // The clock is fixed, so the order they were proposed in is not kept: compare as sorted lists
    const queued = (await teamStore.forWorkspace(WORKSPACE)).map(item => item.title).sort();
    expect(queued).toEqual([...evalCase.expect.queued].sort());
  } finally {
    forWorkspace.mockRestore();
  }
}
