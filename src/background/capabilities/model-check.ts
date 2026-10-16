/**
 * check_model: tiny requests to the models in use (chat, voice, speech-to-text), their latency and errors, what the
 * model registry already knows (provider health, hosts that keep failing), and a recommended switch decided by
 * fixed rules, never by a model. Switching happens only after the user says yes (switch_model).
 */

export type ModelUse = 'chat' | 'voice' | 'speech';

export type ProbeErrorKind = 'not_set' | 'rate_limit' | 'auth' | 'unreachable' | 'timeout' | 'other';

export interface ModelProbe {
  use: ModelUse;
  providerId: string | null;
  model: string | null;
  ok: boolean;
  latencyMs: number | null;
  errorKind: ProbeErrorKind | null;
  // A plain sentence, never a key or a response body
  error: string | null;
  // Not pinged on purpose (e.g. the voice model while the user is talking through it)
  note?: string;
}

/** A model that could stand in: configured, and not known to be failing. */
export interface ModelOption {
  providerId: string;
  providerName: string;
  model: string;
  local: boolean;
  // ok when the registry's last look succeeded; unknown when it has not looked
  health: 'ok' | 'unknown' | 'error';
  // Its host keeps failing right now (circuit breaker open)
  down: boolean;
  // What it can do, from the catalog: chat, live, audio, transcribe…
  tags: string[];
}

export interface Recommendation {
  use: ModelUse;
  reason: string;
  // A concrete switch the user can say yes to; null when the fix is elsewhere (a key, a setting)
  switchTo: { providerId: string; model: string; local: boolean; label: string } | null;
  // Where the user fixes it by hand
  place: 'models' | 'voice-engines';
}

// Slower than this for a reply of a word or two is too slow to work with
export const SLOW_MS: Record<ModelUse, number> = { chat: 8000, voice: 6000, speech: 8000 };

/** Sorts an error into what the user can do about it. Reads only the status and the message's shape. */
export function classifyError(error: unknown): ProbeErrorKind {
  const record = error as { statusCode?: number; status?: number; name?: string; message?: string; cause?: unknown };
  const status = record?.statusCode ?? record?.status;
  const text = `${record?.name ?? ''} ${record?.message ?? String(error ?? '')}`.toLowerCase();
  if (status === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/.test(text)) return 'rate_limit';
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|forbidden|permission|invalid.*key/.test(text)) {
    return 'auth';
  }
  if (/abort|timed? ?out|timeout/.test(text)) return 'timeout';
  if (/failed to fetch|network|econnrefused|enotfound|unreachable|load failed|connection/.test(text)) {
    return 'unreachable';
  }
  return 'other';
}

const USE_NAMES: Record<ModelUse, string> = { chat: 'chat', voice: 'voice (Live)', speech: 'speech-to-text' };

/** Whether a probe needs a recommendation: it failed, or it answered too slowly to be useful. */
export function needsHelp(probe: ModelProbe): boolean {
  if (probe.note) return false;
  return !probe.ok || (probe.latencyMs !== null && probe.latencyMs > SLOW_MS[probe.use]);
}

/** Options able to do this use, healthy ones first, never the failing provider itself. */
function candidates(probe: ModelProbe, options: ModelOption[]): ModelOption[] {
  const able = options.filter(option => {
    if (option.down || option.health === 'error' || option.providerId === probe.providerId) return false;
    if (probe.use === 'chat') return !option.tags.length || option.tags.includes('chat');
    if (probe.use === 'speech') return option.tags.includes('audio') || option.tags.includes('transcribe');
    return false;
  });
  return able.sort((a, b) => Number(b.health === 'ok') - Number(a.health === 'ok'));
}

/**
 * The fixed rules:
 * - nothing set → pick one in Models & usage;
 * - key refused → replace the key, or use another provider meanwhile;
 * - rate limit or quota → another cloud provider first (a local model is slower but has no limits), then local;
 * - unreachable, timing out, failing or slow → a local model that is running first, then another provider;
 * - voice (Live) → economy voice (speech on the device, a text model answers) when Live is the problem.
 */
export function recommend(probes: ModelProbe[], options: ModelOption[]): Recommendation[] {
  const out: Recommendation[] = [];
  for (const probe of probes.filter(needsHelp)) {
    const name = USE_NAMES[probe.use];
    if (probe.use === 'voice') {
      out.push({
        use: 'voice',
        reason:
          probe.errorKind === 'not_set'
            ? 'Voice has no Gemini key; economy voice works without one.'
            : `The ${name} model ${probe.ok ? 'is slow' : 'is not answering'}${probe.error ? ` (${probe.error})` : ''}.`,
        switchTo: null,
        place: 'voice-engines',
      });
      continue;
    }
    if (probe.errorKind === 'not_set') {
      out.push({ use: probe.use, reason: `No ${name} model is chosen.`, switchTo: null, place: 'models' });
      continue;
    }
    const able = candidates(probe, options);
    const local = able.filter(option => option.local);
    const cloud = able.filter(option => !option.local);
    const order =
      probe.errorKind === 'rate_limit' || probe.errorKind === 'auth' ? [...cloud, ...local] : [...local, ...cloud];
    const pick = order[0];
    const why = !probe.ok
      ? probe.errorKind === 'rate_limit'
        ? `${probe.model} hit a rate limit or its quota`
        : probe.errorKind === 'auth'
          ? `the key for ${probe.providerId} was refused`
          : probe.errorKind === 'timeout'
            ? `${probe.model} did not answer in time`
            : probe.errorKind === 'unreachable'
              ? `${probe.providerId} could not be reached`
              : `${probe.model} failed${probe.error ? ` (${probe.error})` : ''}`
      : `${probe.model} took ${Math.round((probe.latencyMs ?? 0) / 100) / 10} s for a one-word reply`;
    out.push({
      use: probe.use,
      reason: `The ${name} model: ${why}.${probe.errorKind === 'auth' ? ' Replace the key in Models & usage.' : ''}`,
      switchTo: pick
        ? {
            providerId: pick.providerId,
            model: pick.model,
            local: pick.local,
            label: `${pick.model} on ${pick.providerName}${pick.local ? ' (on this computer)' : ''}`,
          }
        : null,
      place: 'models',
    });
  }
  return out;
}

/** What check_model tells the model to say. */
export function describeModelCheck(
  probes: ModelProbe[],
  recommendations: Recommendation[],
  extra: string[] = [],
): string {
  const lines = probes.map(probe => {
    const name = USE_NAMES[probe.use];
    const which = probe.model ? `${probe.model}${probe.providerId ? ` (${probe.providerId})` : ''}` : 'none set';
    if (probe.note) return `${name}: ${which}: ${probe.note}`;
    if (probe.ok) {
      const seconds = Math.round((probe.latencyMs ?? 0) / 100) / 10;
      return `${name}: ${which}: answered in ${seconds} s${probe.latencyMs! > SLOW_MS[probe.use] ? ' (slow)' : ''}.`;
    }
    return `${name}: ${which}: ${probe.errorKind === 'not_set' ? 'not set' : `failed (${probe.errorKind}${probe.error ? `: ${probe.error}` : ''})`}.`;
  });
  lines.push(...extra);
  if (recommendations.length === 0) {
    lines.push('Everything answered normally: no switch is needed.');
  } else {
    for (const item of recommendations) {
      lines.push(
        item.switchTo
          ? `Recommendation: ${item.reason} Switch ${USE_NAMES[item.use]} to ${item.switchTo.label}? Ask the user; only after they say yes, call switch_model with use "${item.use}", provider "${item.switchTo.providerId}", model "${item.switchTo.model}" and confirmed true.`
          : `Recommendation: ${item.reason} ${item.place === 'voice-engines' ? 'Settings › Voice engines can switch voice to economy mode.' : 'Fix it in Models & usage (open_place can open it).'}`,
      );
    }
  }
  return lines.join('\n');
}

/** Whether a switch the model asks for is one check_model recommended: nothing else may be switched to. */
export function isRecommended(
  recommendations: Recommendation[],
  use: string,
  providerId: string,
  model: string,
): Recommendation | null {
  return (
    recommendations.find(
      item => item.use === use && item.switchTo?.providerId === providerId && item.switchTo.model === model,
    ) ?? null
  );
}
