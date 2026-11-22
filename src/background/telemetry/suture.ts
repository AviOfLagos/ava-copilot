// Hosted Suture tracing (suture.nexprove.com/docs/tracing). Opt-in and OFF by default: a call is sent only when the
// build has an ingest key (VITE_SUTURE_API_KEY) AND Settings › Privacy › Hosted tracing is on. Prompt and reply
// text is a further switch (captureContent), also off by default. Otherwise the call just runs, nothing leaves.
import { flushSuture, initSuture, suture } from 'suture-trace';
import { tracingSettingsStore } from '@extension/storage';

const apiKey = (): string | undefined => import.meta.env.VITE_SUTURE_API_KEY || undefined;

let started = false;

async function enabled(): Promise<boolean> {
  const key = apiKey();
  if (!key) return false;
  const settings = await tracingSettingsStore.getSettings().catch(() => null);
  if (!settings || settings.hostedEnabled !== true) return false;
  if (!started) {
    started = true;
    initSuture({ apiKey: key, captureContent: settings.captureContent === true, serviceName: 'ava-copilot' });
  }
  return true;
}

/** One span per agent call when hosted tracing is on; otherwise exactly `fn()`. */
export async function tracedCall<T>(feature: string, fn: () => Promise<T>, input: unknown): Promise<T> {
  if (!(await enabled())) return fn();
  return suture(feature, fn, { input });
}

/** Send what is buffered, if hosted tracing was ever started this session. */
export async function flushHostedTracing(): Promise<void> {
  if (started) await flushSuture();
}

// A change of the content switch takes effect on the next start of the worker: initSuture reads it once.
