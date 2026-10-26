// Each turn's trace goes to Ava Brain, which keeps it on this Mac for Suture (telemetry/traces.ts). Without a paired
// Ava Brain, or with one too old to keep traces, the trace is dropped and nothing else changes.
import { companionClient } from '../companion/client';
import { setTraceSink } from './traces';

setTraceSink(async trace => {
  await companionClient.keepTrace(trace);
}, chrome.runtime.getManifest?.()?.version ?? '');
