import type { Workspace } from '../workspaces';
import type { ProductProfile } from './types';

/**
 * The owner's own product, seeded only when the build sets `VITE_SEED_PROFILE=avi` (see `activeSeedProfile`). A
 * public build never runs this, so nothing of the owner's ships to anyone else.
 *
 * Only facts the owner has given are here: his brief (the one-liner, the repo, the stage, the budget, the Slack
 * channel) and the words of the product's own site, trysuture.com, as it read on 2026-11-20 (who it is for, what
 * it does, the plans and prices). What he has not said yet (the outreach address, the postal address, the beta
 * rule, the social accounts, the north star, where he wants to hear about it) is left empty and reads as "not
 * set": no value is invented to fill a gap.
 */
export const SUTURE_WORKSPACE: Omit<Workspace, 'createdAt'> = {
  id: 'suture',
  name: 'Suture',
  about: 'Suture (trysuture.com): LLM observability, evals and drift detection that end in a fix. In beta.',
  keywords: ['suture', 'trysuture'],
  accounts: {},
};

export const SUTURE_PROFILE: Omit<ProductProfile, 'updatedAt'> = {
  workspaceId: SUTURE_WORKSPACE.id,
  name: 'Suture',
  url: 'https://trysuture.com',
  oneLiner: 'LLM observability, evals and drift detection that end in a fix',
  // The site's "Built for" line
  audience: ['Teams running LLM features in production: agents, chat, writing, support'],
  // The site's headline
  problem: 'Your AI is failing quietly.',
  // The site names these as the tracer Suture reads from and works alongside; it does not claim to replace them
  alternatives: [
    'A tracer on its own (Langfuse, LangSmith, Braintrust or plain OpenTelemetry) and fixing by hand. Suture works alongside the tracer, it does not replace it',
  ],
  differentiators: [
    'It checks every trace your AI app produces, groups the failures into Issues, writes the fix, proves it on your real traces and opens a pull request',
    'Reads OpenTelemetry over OTLP/HTTP from any language, or Langfuse with project keys',
    'Produces Issues with a rate and trend, drift alerts, and one proven GitHub PR per Issue',
  ],
  // The site's plans and its "How do I get access?" answer
  pricing:
    'Free: 1,000 traces a month analysed end to end, up to 3 fixes a month. Pro: $149 a month. Team: $399 a month. Sign up free with a work email: no card, no waitlist. Everyone starts on Free; Pro and Team open when checkout does.',
  stage: 'beta',
  repo: 'AviOfLagos/suture',
  // The login that may use the console is the owner's to say
  superAdmin: { url: 'https://admin.trysuture.com', account: '' },
  slackChannels: [{ name: '#suture-notifications', id: 'C0CKJC0CT4M' }],
  social: {},
  email: null,
  postalAddress: '',
  notify: null,
  northStar: null,
  budget: { totalUsd: 100, spentUsd: 0 },
  betaRule: null,
  never: [],
};

// Seeds that have run are remembered by this name, so a profile the owner deleted stays deleted
export const SUTURE_SEED = 'suture-2026-11';
