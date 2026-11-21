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
export type EvalCase = PlannerCase | SkillsCase | VoiceCase | DraftCase;
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
