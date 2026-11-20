/**
 * ask_human: show Avi numbered steps and wait for Done or "I can't". v0 is a macOS notification plus a dialog
 * (osascript, text passed as arguments, never spliced into the script). The dialog has no text field: Ava never
 * asks Avi to type a secret into something an agent wrote. The Ava panel with on-screen pointers comes later.
 */
import type { ProcessRunner } from '../sandbox/process';

export const MAX_STEPS = 10;
export const MAX_STEP_LENGTH = 140;
export const MAX_PURPOSE_LENGTH = 120;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface AskStep {
  text: string;
  // What a pointer should point at later (a CSS selector, a window, a screen rectangle); v0 does not show it
  target?: string;
}

export interface AskRequest {
  purpose: string;
  steps: AskStep[];
  agent: string;
  timeoutSeconds?: number;
}

export interface AskResult {
  answer: 'done' | 'cant' | 'timeout';
  seconds: number;
  message: string;
}

const SCRIPT = `on run argv
  set theTitle to item 1 of argv
  set theText to item 2 of argv
  set secs to (item 3 of argv) as integer
  display notification (item 4 of argv) with title theTitle sound name "Glass"
  activate
  try
    set r to display dialog theText with title theTitle buttons {"I can't", "Done"} default button "Done" giving up after secs with icon note
    if gave up of r then return "timeout"
    return button returned of r
  on error number -128
    return "I can't"
  end try
end run`;

export function validateAsk(req: AskRequest): string | null {
  if (!req.purpose.trim() || req.purpose.length > MAX_PURPOSE_LENGTH) return `purpose must be 1 to ${MAX_PURPOSE_LENGTH} characters`;
  if (!req.steps.length || req.steps.length > MAX_STEPS) return `give 1 to ${MAX_STEPS} steps`;
  for (const [i, step] of req.steps.entries()) {
    if (!step.text.trim() || step.text.length > MAX_STEP_LENGTH) return `step ${i + 1} must be 1 to ${MAX_STEP_LENGTH} characters`;
    if (UNSAFE.test(step.text)) return `step ${i + 1} contains control or invisible characters`;
  }
  if (UNSAFE.test(req.purpose)) return 'purpose contains control or invisible characters';
  return null;
}

/** The dialog text: who asks, why, then the numbered steps. */
export function dialogText(req: AskRequest): string {
  const steps = req.steps.map((step, i) => `${i + 1}. ${step.text.trim()}`).join('\n');
  return `${req.agent} asks: ${req.purpose.trim()}\n\n${steps}\n\nPress Done when finished, or I can't.`;
}

export async function askHuman(req: AskRequest, runner: ProcessRunner, now: () => number = Date.now): Promise<AskResult> {
  const invalid = validateAsk(req);
  if (invalid) throw new Error(invalid);
  const secs = Math.min(Math.max(Math.round(req.timeoutSeconds ?? 600), 15), 1800);
  const title = `Ava: ${req.agent} needs you`;
  const started = now();
  const result = await runner('/usr/bin/osascript', ['-e', SCRIPT, title, dialogText(req), String(secs), req.purpose.trim()], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' },
    timeoutMs: (secs + 30) * 1000,
  });
  const seconds = Math.round((now() - started) / 1000);
  const said = result.stdout.trim();
  if (said === 'Done') return { answer: 'done', seconds, message: 'Avi pressed Done' };
  if (said === "I can't") return { answer: 'cant', seconds, message: "Avi pressed I can't" };
  if (said === 'timeout' || result.timedOut) return { answer: 'timeout', seconds, message: `no answer in ${secs} seconds` };
  throw new Error(`the dialog could not be shown (${result.stderr.trim().slice(0, 200) || `exit ${result.code}`})`);
}
