import { SOCIAL_PLATFORMS } from '@extension/storage';
import type { ProductProfile } from '@extension/storage';

/**
 * What an agent is told about the product of the workspace it works in (docs/growth-team.md, Part 6 and rule 2).
 * These lines are the only product facts it may state. A fact the user has not filled in reads "not set", so the
 * agent can say it does not know rather than fill the gap.
 */

const NOT_SET = 'not set';
const or = (value: string | undefined | null) => value?.trim() || NOT_SET;
const many = (values: string[]) => (values.length ? values.join('; ') : NOT_SET);
const usd = (value: number) => '$' + (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** The profile as labelled lines, the same for the model and for anything that prints it. */
export function productLines(profile: ProductProfile): [label: string, value: string][] {
  const social = SOCIAL_PLATFORMS.flatMap(platform => {
    const account = profile.social[platform];
    return account?.handle ? [`${platform}: ${account.handle}`] : [];
  });
  const admin = profile.superAdmin?.url
    ? profile.superAdmin.url + (profile.superAdmin.account ? ` (as ${profile.superAdmin.account})` : '')
    : NOT_SET;
  const channels = profile.slackChannels.map(channel => channel.name || channel.id);
  return [
    ['Name', or(profile.name)],
    ['Site', or(profile.url)],
    ['In one line', or(profile.oneLiner)],
    ['Stage', profile.stage],
    ['Who it is for (most valuable first)', many(profile.audience)],
    ['The problem it solves', or(profile.problem)],
    ['What people use instead', many(profile.alternatives)],
    ['Why this one', many(profile.differentiators)],
    ['Pricing', or(profile.pricing)],
    ['Repo (where issues go)', or(profile.repo)],
    ['Admin console', admin],
    ['Slack channels with its notifications', channels.length ? channels.join(', ') : NOT_SET],
    ['Social accounts', social.length ? social.join(', ') : NOT_SET],
    ['Outreach email comes from', or(profile.email?.from)],
    ['Postal address for email footers', or(profile.postalAddress)],
    ['The user hears about it on', profile.notify ?? NOT_SET],
    [
      'North star',
      profile.northStar ? `${profile.northStar.metric}, ${profile.northStar.weeklyTarget} a week` : NOT_SET,
    ],
    [
      'Marketing budget',
      profile.budget ? `${usd(profile.budget.totalUsd)} in total, ${usd(profile.budget.spentUsd)} spent` : NOT_SET,
    ],
    [
      'Beta rule',
      profile.betaRule
        ? `${profile.betaRule.testersPerWeek} testers a week, ${profile.betaRule.plan} plan, ${profile.betaRule.days} days`
        : NOT_SET,
    ],
    ['Never say or do', many(profile.never)],
  ];
}

/** The product section of the state message. */
export function productSection(profile: ProductProfile): string {
  return [
    `[Product: ${profile.name || 'unnamed'}]`,
    'These are the only facts about this product you may state. If a fact is not here (a feature, a price, a customer, a number, a date), or reads "not set", say you do not know it and ask the user or leave it out. Never make one up, and never fill a "not set" with a guess.',
    ...productLines(profile).map(([label, value]) => `${label}: ${value}`),
    'To change any of this, use update_product_profile: the user confirms the change before it is saved.',
  ].join('\n');
}
