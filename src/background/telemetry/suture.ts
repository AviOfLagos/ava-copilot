// Hosted Suture tracing (suture.nexprove.com/docs/tracing). Opt-in and OFF by default: a call is sent only when the
// build has an ingest key (VITE_SUTURE_API_KEY) AND Settings › Privacy › Hosted tracing is on. Prompt and reply
// text is a further switch (captureContent), also off by default. Otherwise the call just runs, nothing leaves.
//
// Both switches are read again on every call, and content is withheld here, not only by the library's own flag:
// with captureContent off, the span gets no input and a result with the text removed (model and usage only).
// Turning tracing off drops anything still buffered.
import { _resetSuture, flushSuture, initSuture, suture } from 'suture-trace';
import { tracingSettingsStore } from '@extension/storage';

const apiKey = (): string | undefined => import.meta.env.VITE_SUTURE_API_KEY || undefined;

/** The captureContent value the library was started with, or null when it is not running. */
let startedWith: boolean | null = null;

function stop(): void {
  if (startedWith === null) return;
  _resetSuture(); // drops buffered spans: nothing is sent after consent is withdrawn
  startedWith = null;
}

/** Whether to trace and whether content may be sent. Starts, restarts or stops the library to match. */
async function current(): Promise<{ on: boolean; capture: boolean }> {
  const key = apiKey();
  const settings = key ? await tracingSettingsStore.getSettings().catch(() => null) : null;
  if (!key || !settings || settings.hostedEnabled !== true) {
    stop();
    return { on: false, capture: false };
  }
  const capture = settings.captureContent === true;
  if (startedWith !== capture) {
    stop();
    initSuture({ apiKey: key, captureContent: capture, serviceName: 'ava-copilot' });
    startedWith = capture;
  }
  return { on: true, capture };
}

const CONTENT_KEYS = new Set(['text', 'rawText', 'output', 'content', 'messages']);

/** A copy of a call's result without any prompt or reply text, for spans sent with content off. */
export function withoutContent(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  return Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([k]) => !CONTENT_KEYS.has(k)));
}

/** One span per agent call when hosted tracing is on; otherwise exactly `fn()`. The caller always gets fn's result. */
export async function tracedCall<T>(feature: string, fn: () => Promise<T>, input: unknown): Promise<T> {
  const { on, capture } = await current();
  if (!on) return fn();
  let full!: T;
  await suture(
    feature,
    async () => {
      full = await fn();
      return capture ? full : withoutContent(full);
    },
    capture ? { input } : {},
  );
  return full;
}

/** Send what is buffered, only while hosted tracing is still on. */
export async function flushHostedTracing(): Promise<void> {
  if (startedWith === null) return;
  const { on } = await current();
  if (on) await flushSuture();
}
