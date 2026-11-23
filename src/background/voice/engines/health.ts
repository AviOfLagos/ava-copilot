import { t } from '@extension/i18n';
import {
  localSttChoice,
  localTtsUsable,
  localVoice,
  voiceEngineSettingsStore,
  voiceHealthStore,
  voiceTraceStore,
  worthRecording,
} from '@extension/storage';
import type { LocalTtsEngineId, VoiceHealth, VoiceTraceEntry } from '@extension/storage';
import { addInboxItem } from '../../inbox/store';
import { createLogger } from '../../log';
import { installedVoiceModels } from './models';
import { toVoiceOffscreen } from './offscreen';
import type { SpokenReport } from './wire';

const logger = createLogger('voice-health');

/**
 * How the voices are doing on this computer: every spoken answer leaves a content-free line in the trace and moves
 * the measured speed; a local voice that makes speech slower than it plays is replaced by the computer's own voice,
 * and the Inbox says so once a day. Code decides all of it from the numbers.
 */

/** An answer the offscreen document has spoken: a line in the trace, and a reading of how fast the voice is. */
export async function recordSpoken(report: SpokenReport): Promise<void> {
  const entry: VoiceTraceEntry = {
    at: Date.now(),
    kind: 'tts',
    engine: report.engine,
    ok: report.ok,
    chars: report.chars,
    audioSeconds: report.audioSeconds,
    workMs: report.workMs,
    ...(report.speed ? { speed: report.speed } : {}),
    ...(report.loadMs ? { loadMs: report.loadMs } : {}),
    ...(report.firstAudioMs !== null ? { firstAudioMs: report.firstAudioMs } : {}),
    ...(report.gaps.count ? { gaps: report.gaps } : {}),
    ...(report.note ? { note: report.note } : {}),
  };
  await voiceTraceStore.append(entry);
  if (report.ok && report.speed && worthRecording(report.chars, report.audioSeconds)) {
    await voiceHealthStore.recordTtsSpeed(report.engine, report.speed, 'observed');
  }
}

/**
 * A conversation that was not hearing the user well ('mic-silent' or 'unclear-turns'): a line in the trace with
 * the recogniser in use, so Settings › Voice engines and check_audio can see it happened. A code, never words.
 */
export async function recordHearingTrouble(trouble: unknown, engine: string): Promise<void> {
  if (trouble !== 'mic-silent' && trouble !== 'unclear-turns') return;
  await voiceTraceStore.append({ at: Date.now(), kind: 'stt', engine, ok: false, note: trouble });
}

/** The local voice that was meant to speak but is too slow here, with its speed, or null when it can speak. */
export function slowVoice(
  engine: string,
  health: Pick<VoiceHealth, 'tts'>,
  chars = Number.POSITIVE_INFINITY,
): { engine: LocalTtsEngineId; speed: number } | null {
  if (engine !== 'kitten' && engine !== 'kokoro') return null;
  if (localTtsUsable(engine, health, chars)) return null;
  return { engine, speed: health.tts[engine]?.speed ?? 0 };
}

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A line in the trace, the reason in Settings, and one Inbox alert a day saying the computer's voice took over. */
export async function noteSlowFallback(slow: { engine: LocalTtsEngineId; speed: number }): Promise<void> {
  const at = Date.now();
  try {
    await voiceTraceStore.append({
      at,
      kind: 'fallback',
      engine: slow.engine,
      ok: true,
      speed: slow.speed,
      note: 'slower-than-speech',
    });
    await voiceHealthStore.updateHealth({ lastFallback: { at, engine: slow.engine, speed: slow.speed } });
    await addInboxItem({
      source: 'system',
      externalId: `voice-slow:${slow.engine}:${dayKey(at)}`,
      kind: 'alert',
      title: t('voice_health_fallback_title'),
      body: t('voice_health_fallback_body', [
        t(slow.engine === 'kokoro' ? 'voice_engine_name_kokoro' : 'voice_engine_name_kitten'),
        slow.speed.toFixed(1),
      ]),
      priority: 'low',
    });
  } catch (error) {
    // Telling is a courtesy; the answer is still spoken
    logger.warning('Could not note the voice fallback', error);
  }
}

export interface CheckResult {
  machine: NonNullable<VoiceHealth['machine']>;
  tts: Partial<Record<LocalTtsEngineId, { ok: boolean; speed?: number; loadMs?: number; error?: string }>>;
  stt: { engine: string; ok: boolean; speed?: number; right?: number; error?: string } | null;
}

interface BenchmarkReply {
  ok?: boolean;
  error?: string;
  machine?: CheckResult['machine'];
  tts?: CheckResult['tts'];
  stt?: { ok: boolean; speed?: number; right?: number; error?: string };
}

/**
 * Times every voice installed on this computer with a fixed line, and the recogniser on what a voice said. The result
 * is kept (it decides what is recommended and when a voice is too slow) and a line goes into the trace.
 */
export async function checkThisComputer(): Promise<CheckResult> {
  checking = true;
  try {
    return await runCheck();
  } finally {
    checking = false;
  }
}

// While the check runs the offscreen document must stay open: it is not "speaking", and an idle one is closed
let checking = false;
export const checkRunning = (): boolean => checking;

async function runCheck(): Promise<CheckResult> {
  const [settings, installed] = await Promise.all([voiceEngineSettingsStore.getSettings(), installedVoiceModels()]);
  const engines = (['kitten', 'kokoro'] as const)
    .filter(engine => installed[engine])
    .map(engine => ({ engine, voice: localVoice(engine, settings) }));
  const stt = localSttChoice(settings, installed);
  const reply = await toVoiceOffscreen<BenchmarkReply>({ type: 'voice_benchmark', engines, stt });
  if (!reply?.ok || !reply.machine) throw new Error(reply?.error || t('voice_health_check_failed'));

  const at = Date.now();
  await voiceHealthStore.updateHealth({ machine: reply.machine, checkedAt: at });
  for (const [engine, result] of Object.entries(reply.tts ?? {}) as [
    LocalTtsEngineId,
    NonNullable<CheckResult['tts'][LocalTtsEngineId]>,
  ][]) {
    if (result.ok && result.speed) await voiceHealthStore.recordTtsSpeed(engine, result.speed, 'benchmark');
    await voiceTraceStore.append({
      at,
      kind: 'check',
      engine,
      ok: result.ok,
      ...(result.speed ? { speed: result.speed } : {}),
      ...(result.loadMs ? { loadMs: result.loadMs } : {}),
      ...(result.error ? { note: 'check-failed' } : {}),
    });
  }
  if (stt && reply.stt?.ok && reply.stt.speed) {
    await voiceHealthStore.recordSttSpeed(stt.engine, reply.stt.speed, 'benchmark');
  }
  return {
    machine: reply.machine,
    tts: reply.tts ?? {},
    stt: stt && reply.stt ? { engine: stt.engine, ...reply.stt } : null,
  };
}
