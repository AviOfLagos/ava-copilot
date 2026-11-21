import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';

/**
 * Eval cases: one JSON file each under evals/cases (written by hand from a failure) or evals/suture (written by
 * Suture from a failing trace). Each says what Ava was given, what the model said back (so the case replays without
 * a model), and what must be true of what the user gets.
 */

const plannerExpect = z.object({
  // The answer the user gets is not empty, "None" or another placeholder
  answer_not_empty: z.boolean().optional(),
  // Answers the user must never get, word for word (case-insensitive, trimmed)
  answer_not: z.array(z.string()).optional(),
  // Patterns the answer must, or must not, match (regex source, case-insensitive)
  answer_matches: z.array(z.string()).optional(),
  answer_not_matches: z.array(z.string()).optional(),
  // Patterns the planner's system prompt must, or must not, match: what the model is told
  prompt_matches: z.array(z.string()).optional(),
  prompt_not_matches: z.array(z.string()).optional(),
});

export const plannerCase = z.object({
  kind: z.literal('planner'),
  name: z.string(),
  // The user's message, as the planner gets it ("(voice note) …" for a WhatsApp voice note)
  input: z.string().min(1),
  channel: z.enum(['whatsapp', 'user', 'voice', 'agent', 'workflow', 'brief']).default('user'),
  // What the model said, in order: a final answer, or the planner's whole JSON reply. A call past the end gets the
  // last one again, the way a model that said "None" says it again.
  replay: z.object({ planner: z.array(z.string()).min(1) }).optional(),
  expect: plannerExpect,
  // Checked only against a live model (AVA_EVAL_OLLAMA_MODEL): what a recorded reply cannot show
  live: plannerExpect.optional(),
  source: z.unknown().optional(),
});

export const skillsCase = z.object({
  kind: z.literal('skills'),
  name: z.string(),
  input: z.string().min(1),
  // The tab in front when the message came
  url: z.string().url(),
  expect: z.object({ skills: z.array(z.string()) }),
  source: z.unknown().optional(),
});

const voiceStep = z.union([
  // Speech the recogniser writes down as `say`, near the microphone or across the room, then `pause` chunks of
  // quiet (a quarter second each; 5 ends a turn, 1–3 is a breath)
  z.object({ say: z.string(), level: z.enum(['near', 'far']).default('near'), pause: z.int().min(0).default(5) }),
  // Quiet chunks
  z.object({ quiet: z.int().min(1) }),
  // Time passing with nothing heard (ms)
  z.object({ wait_ms: z.int().min(1) }),
]);

export const voiceCase = z.object({
  kind: z.literal('voice'),
  name: z.string(),
  assistant_name: z.string().default('Ava'),
  heard: z.array(voiceStep).min(1),
  // The turns Ava answers, each as the words she was asked with, in order
  expect: z.object({ turns: z.array(z.string()) }),
  source: z.unknown().optional(),
});

/**
 * A draft an agent wrote for other people, under a personality: what the personality tells the model, and what
 * code does with the draft before it can reach the Inbox (src/background/growth-team/persona.ts).
 */
export const draftCase = z.object({
  kind: z.literal('draft'),
  name: z.string(),
  // A built-in personality id
  personality: z.string().min(1),
  action: z.enum(['post', 'reply', 'outreach_email', 'follow_up', 'listing', 'customer_issue']),
  // What the model wrote, as it would reach queue_for_approval
  replay: z.object({ title: z.string().min(1), text: z.string().min(1) }),
  expect: z.object({
    // Whether code refuses the draft
    refused: z.boolean(),
    // Patterns the refusal must match (regex source, case-insensitive)
    why_matches: z.array(z.string()).optional(),
    // Patterns the personality's prompt section must match: what the model is told
    prompt_matches: z.array(z.string()).optional(),
  }),
  source: z.unknown().optional(),
});

const leadSort = z.object({
  tool: z.literal('sort_feedback'),
  feedback_id: z.string(),
  sort: z.enum(['bug', 'confusion', 'feature', 'billing', 'praise']),
  title: z.string(),
  summary: z.string(),
  topic: z.string().default(''),
  facts: z
    .object({
      data_loss: z.boolean(),
      security: z.boolean(),
      cannot_sign_in: z.boolean(),
      payment_broken: z.boolean(),
      main_flow_broken: z.boolean(),
      paying_customer: z.boolean(),
      users_affected: z.number(),
      has_workaround: z.boolean(),
    })
    .partial()
    .default({}),
});
const leadGrant = z.object({ tool: z.literal('request_beta_grant'), request_id: z.string(), why: z.string() });
// The Product Marketing Manager's calls; `at_day` moves the clock that many days on from the case's Monday
const atDay = z.number().int().min(0).max(60).default(0);
const marketingOutreach = z.object({
  tool: z.literal('draft_outreach'),
  at_day: atDay,
  email: z.string(),
  source: z.string(),
  why: z.string(),
  subject: z.string(),
  body: z.string(),
});
const marketingFollowUp = z.object({
  tool: z.literal('draft_follow_up'),
  at_day: atDay,
  email: z.string(),
  subject: z.string(),
  body: z.string(),
});
const marketingStop = z.object({
  tool: z.literal('stop_contact'),
  email: z.string(),
  why: z.enum(['replied', 'unsubscribed', 'bounced', 'asked']),
});
const marketingChannel = z.object({
  tool: z.literal('add_channel'),
  channel: z.string(),
  reach: z.string(),
  cost_usd: z.number().default(0),
});
const marketingRank = z.object({ tool: z.literal('rank_channels') });
// The user's yes to the item with this title, on that day: not a model call, the click the agent waits for
// A draft for other people, as the agent leaves it with queue_for_approval
const queueDraft = z.object({
  tool: z.literal('queue_for_approval'),
  kind: z.enum(['post', 'reply', 'listing', 'new_account']),
  title: z.string(),
  text: z.string(),
  where: z.string(),
});
const userApproves = z.object({ tool: z.literal('user_approves'), at_day: atDay, title: z.string() });

/**
 * A growth agent's recorded tool calls (the Growth Lead's, kind `lead`; the Product Marketing Manager's, kind
 * `marketing`), replayed through the code behind them (src/background/growth-team): what each call ends as, and
 * what reached the approval queue.
 */
export const teamCase = z.object({
  kind: z.enum(['lead', 'marketing', 'social']),
  name: z.string(),
  // The product's beta rule, and what the product says is left this week (absent: the product was not asked)
  beta: z
    .object({
      rule: z.object({ testersPerWeek: z.number(), days: z.number(), plan: z.string() }),
      remaining: z.number().optional(),
    })
    .optional(),
  // The profile's sender and postal address; both are set unless the case says otherwise
  profile: z.object({ sender: z.string(), postal_address: z.string(), pricing: z.string() }).partial().optional(),
  // Sign-ups a day per channel over the 28 days before the case's Monday, every day read
  signups_per_day: z.record(z.string(), z.number()).optional(),
  replay: z
    .array(
      z.discriminatedUnion('tool', [
        leadSort,
        leadGrant,
        marketingOutreach,
        marketingFollowUp,
        marketingStop,
        marketingChannel,
        marketingRank,
        userApproves,
        queueDraft,
      ]),
    )
    .min(1),
  expect: z.object({
    // One per replayed call: what it ended as, and patterns its text must match
    steps: z.array(
      z.object({
        state: z.enum(['sorted', 'already', 'refused', 'queued', 'ok']),
        matches: z.array(z.string()).optional(),
      }),
    ),
    // The titles waiting in the approval queue afterwards, in any order
    queued: z.array(z.string()),
  }),
  source: z.unknown().optional(),
});

/**
 * What Suture writes for a failing trace (evals/suture/<issue>/<trace>.eval.json): the user's message, the answer
 * that failed, and the model's recorded replies when the trace has them. Replayed as a planner case: the user must
 * not get the failing answer again, nor an empty one.
 */
export const sutureCase = z.object({
  name: z.string(),
  input: z.string().min(1),
  failing_output: z.string(),
  suture: z.object({ issue_id: z.string(), trace_id: z.string() }).passthrough(),
  replay: z
    .object({ outputs: z.array(z.object({ agent: z.string().optional(), text: z.string() })) })
    .partial()
    .optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  expect: z.unknown().optional(),
});

export type PlannerCase = z.infer<typeof plannerCase>;
export type SkillsCase = z.infer<typeof skillsCase>;
export type VoiceCase = z.infer<typeof voiceCase>;
export type DraftCase = z.infer<typeof draftCase>;
export type TeamCase = z.infer<typeof teamCase>;
export type EvalCase = PlannerCase | SkillsCase | VoiceCase | DraftCase | TeamCase;
export type VoiceStep = z.infer<typeof voiceStep>;

const CHANNELS = new Set(plannerCase.shape.channel.unwrap().options as readonly string[]);

/** A Suture case as the planner case it stands for. */
export function fromSuture(raw: z.infer<typeof sutureCase>): PlannerCase {
  const recorded = (raw.replay?.outputs ?? []).filter(output => !output.agent || output.agent === 'planner');
  const channel = raw.attributes?.['ava.channel'];
  return plannerCase.parse({
    kind: 'planner',
    name: raw.name,
    input: raw.input,
    ...(typeof channel === 'string' && CHANNELS.has(channel) ? { channel } : {}),
    replay: { planner: recorded.length ? recorded.map(output => output.text) : [raw.failing_output] },
    expect: { answer_not_empty: true, ...(raw.failing_output.trim() ? { answer_not: [raw.failing_output] } : {}) },
    source: raw.suture,
  });
}

function parseCase(raw: unknown): EvalCase {
  const kind = (raw as { kind?: unknown })?.kind;
  if (kind === 'planner') return plannerCase.parse(raw);
  if (kind === 'skills') return skillsCase.parse(raw);
  if (kind === 'voice') return voiceCase.parse(raw);
  if (kind === 'draft') return draftCase.parse(raw);
  if (kind === 'lead' || kind === 'marketing' || kind === 'social') return teamCase.parse(raw);
  return fromSuture(sutureCase.parse(raw));
}

function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return name.endsWith('.eval.json') ? [path] : [];
  });
}

/** Every case under the evals folder, with the file it came from; a file that does not parse is an error. */
export function loadCases(root: string): { file: string; evalCase: EvalCase }[] {
  return [...filesUnder(join(root, 'cases')), ...filesUnder(join(root, 'suture'))].map(path => {
    const file = relative(root, path);
    try {
      return { file, evalCase: parseCase(JSON.parse(readFileSync(path, 'utf8'))) };
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
