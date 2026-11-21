import { expect, vi } from 'vitest';
import { db, emptyProductProfile, productStore, shiftDay, teamStore, utcDay } from '@extension/storage';
import type { GrowthMetric, GrowthReading, ProductProfile } from '@extension/storage';
import { requestBetaGrant } from '@src/background/growth-team/lead/actions';
import { NO_FACTS } from '@src/background/growth-team/lead/priority';
import { sortFeedback } from '@src/background/growth-team/lead/feedback';
import type { LeadDeps } from '@src/background/growth-team/lead/feedback';
import { addChannel, rankChannels, rankedText } from '@src/background/growth-team/marketing/channels';
import type { ChannelStore } from '@src/background/growth-team/marketing/channels';
import { draftFollowUp, draftOutreach, stopContact } from '@src/background/growth-team/marketing/outreach';
import type { OutreachResult } from '@src/background/growth-team/marketing/outreach';
import { resultText } from '@src/background/growth-team/queue';
import type { TeamCase } from './cases';

const WORKSPACE = 'eval-product';
const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed Monday noon (UTC), so the day's limits and the working days count the same on every run
const MONDAY = Date.parse('2026-11-23T12:00:00Z');

/** Sign-ups a day per channel for the 28 days before the case's Monday, all of them read. */
function channelStoreFor(perDay: Record<string, number> | undefined): ChannelStore {
  const days = Array.from({ length: 28 }, (_, index) => shiftDay(utcDay(MONDAY), -(index + 1)));
  const base = { productId: WORKSPACE, source: 'product' as const, metric: 'signups', readAt: MONDAY };
  const metrics: GrowthMetric[] = Object.entries(perDay ?? {}).flatMap(([channel, value]) =>
    days.map(date => ({ ...base, id: `${date}|${channel}`, date, value, channel })),
  );
  const readings: GrowthReading[] = days.map(date => ({
    ...base,
    id: date,
    date,
    status: 'ok',
    reason: null,
    detail: null,
  }));
  return { metrics: async () => metrics, readings: async () => readings };
}

const outreachText = (result: OutreachResult) =>
  result.state === 'refused' ? result.why : `${result.text} ${resultText(result.result)}`;

/**
 * A growth agent's recorded tool calls through the code that acts on them. A recorded call cannot show the model
 * judges well; it shows that what it decided is kept to the rules. The Growth Lead: the priority comes from the
 * rule, one issue per feedback, the third ask opens a feature issue, a customer's details never reach an issue,
 * and a beta place past the product's rule is refused. The Product Marketing Manager: no email to a suppressed
 * address, no more than 20 new people a day, one follow-up and then stop, channels ranked from the numbers.
 */
export async function runTeamCase(evalCase: TeamCase): Promise<void> {
  await Promise.all(
    [db.teamItems, db.teamLedger, db.teamFeedback, db.teamContacts, db.teamSuppressed, db.teamChannels].map(table =>
      table.clear(),
    ),
  );
  const sender = evalCase.profile?.sender ?? 'hello@example.com';
  const profile: ProductProfile = {
    ...emptyProductProfile({ id: WORKSPACE, name: 'Eval product' }),
    repo: 'example/eval-product',
    superAdmin: { url: 'https://admin.example.com', account: 'owner' },
    betaRule: evalCase.beta?.rule ?? null,
    email: sender ? { from: sender, replyTo: sender, via: 'nexmail' } : null,
    postalAddress: evalCase.profile?.postal_address ?? '1 Example Street, Lagos',
  };
  const who = {
    workspaceId: WORKSPACE,
    agentId: evalCase.kind,
    agentName: evalCase.kind === 'lead' ? 'Growth Lead' : 'Product Marketing Manager',
  };
  const forWorkspace = vi
    .spyOn(productStore, 'forWorkspace')
    .mockImplementation(async id => (id === WORKSPACE ? profile : undefined));
  const remaining = evalCase.beta?.remaining;
  const channelStore = channelStoreFor(evalCase.signups_per_day);
  try {
    expect(evalCase.expect.steps, 'one expectation per replayed call').toHaveLength(evalCase.replay.length);
    for (const [index, call] of evalCase.replay.entries()) {
      const want = evalCase.expect.steps[index]!;
      const now = MONDAY + ('at_day' in call ? call.at_day : 0) * DAY_MS;
      const deps: LeadDeps = {
        now: () => now,
        publish: async () => undefined,
        remoteGrants: async () => (remaining === undefined ? null : { remaining }),
      };
      let state: string;
      let text: string;
      if (call.tool === 'sort_feedback') {
        const facts = call.facts;
        const result = await sortFeedback(
          profile,
          who,
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
      } else if (call.tool === 'request_beta_grant') {
        const result = await requestBetaGrant(profile, who, { requestId: call.request_id, why: call.why }, deps);
        state = result.state === 'refused' ? 'refused' : 'queued';
        text = resultText(result);
      } else if (call.tool === 'draft_outreach' || call.tool === 'draft_follow_up') {
        const result =
          call.tool === 'draft_outreach'
            ? await draftOutreach(profile, who, call, deps)
            : await draftFollowUp(profile, who, call, deps);
        state = result.state === 'refused' ? 'refused' : 'queued';
        text = outreachText(result);
      } else if (call.tool === 'stop_contact') {
        state = 'ok';
        text = await stopContact(call.email, call.why, now);
      } else if (call.tool === 'add_channel') {
        const added = await addChannel(
          WORKSPACE,
          { key: call.channel, reach: call.reach, costUsd: call.cost_usd },
          now,
        );
        state = added.ok ? 'ok' : 'refused';
        text = added.ok ? `${added.channel.key} added` : added.why;
      } else {
        state = 'ok';
        text = rankedText(await rankChannels(WORKSPACE, now, channelStore));
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
