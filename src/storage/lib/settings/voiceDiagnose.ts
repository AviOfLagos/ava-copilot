import { TTS_STEADY_SPEED, ttsVerdict, sttVerdict } from './voiceHealth';
import type { VoiceHealth, VoiceTraceEntry } from './voiceHealth';
import type { VoicePresetId } from './voicePresets';

/**
 * What the voice trace says went wrong, decided by code: thresholds on measured times, no model. Each finding is a
 * code with its figures; the panel words it (so it is translated) and offers the fix. The same trace makes the
 * content-free report that can go into an issue.
 */

export type FindingId =
  | 'tts-slower-than-speech'
  | 'tts-pauses'
  | 'tts-slow-start'
  | 'tts-failing'
  | 'stt-slow'
  | 'fallback-used'
  | 'unchecked';

export interface VoiceFinding {
  id: FindingId;
  severity: 'problem' | 'note';
  // The figures the sentence names, as text: the engine, a speed, seconds
  params: string[];
  fix?: { kind: 'preset'; preset: VoicePresetId } | { kind: 'check' };
}

const RECENT = 12;
const WEEK_MS = 7 * 24 * 3600 * 1000;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function diagnoseVoice(input: {
  entries: VoiceTraceEntry[];
  health: Pick<VoiceHealth, 'tts' | 'stt' | 'checkedAt'>;
  now?: number;
}): VoiceFinding[] {
  const now = input.now ?? Date.now();
  const recent = input.entries.filter(entry => now - entry.at < WEEK_MS).slice(-RECENT * 3);
  const local = recent.filter(
    entry => entry.kind === 'tts' && (entry.engine === 'kitten' || entry.engine === 'kokoro'),
  );
  const findings: VoiceFinding[] = [];

  // Speech made slower than it plays: the one cause of a pause after every sentence
  for (const engine of ['kitten', 'kokoro'] as const) {
    const mine = local.filter(entry => entry.engine === engine && entry.ok && entry.speed);
    const measured = input.health.tts[engine]?.speed;
    const speeds = mine.slice(-6).map(entry => entry.speed as number);
    const speed = speeds.length >= 2 ? median(speeds) : measured;
    if (speed !== undefined && speed < TTS_STEADY_SPEED) {
      findings.push({
        id: 'tts-slower-than-speech',
        severity: ttsVerdict(speed) === 'too-slow' ? 'problem' : 'note',
        params: [engine, speed.toFixed(2)],
        fix: { kind: 'preset', preset: 'instant' },
      });
    }
  }

  const heardPauses = local
    .slice(-5)
    .filter(entry => (entry.gaps?.totalMs ?? 0) >= 1500 || (entry.gaps?.longestMs ?? 0) >= 2000);
  if (heardPauses.length >= 2) {
    const longest = Math.max(...heardPauses.map(entry => entry.gaps?.longestMs ?? 0));
    findings.push({
      id: 'tts-pauses',
      severity: 'problem',
      params: [String(heardPauses.length), seconds(longest)],
      fix: { kind: 'preset', preset: 'instant' },
    });
  }

  const starts = local.filter(entry => entry.firstAudioMs !== undefined).slice(-5);
  if (starts.length >= 2) {
    const slowest = median(starts.map(entry => entry.firstAudioMs as number));
    if (slowest >= 4000) findings.push({ id: 'tts-slow-start', severity: 'note', params: [seconds(slowest)] });
  }

  const failed = recent
    .filter(entry => entry.kind === 'tts')
    .slice(-5)
    .filter(entry => !entry.ok);
  if (failed.length >= 2) findings.push({ id: 'tts-failing', severity: 'problem', params: [String(failed.length)] });

  for (const engine of ['moonshine', 'whisper', 'vosk'] as const) {
    const speed = input.health.stt[engine]?.speed;
    if (speed !== undefined && sttVerdict(speed) !== 'fast' && sttVerdict(speed) !== 'steady') {
      findings.push({ id: 'stt-slow', severity: speed < 1 ? 'problem' : 'note', params: [engine, speed.toFixed(2)] });
    }
  }

  const fallbacks = recent.filter(entry => entry.kind === 'fallback');
  if (fallbacks.length) findings.push({ id: 'fallback-used', severity: 'note', params: [String(fallbacks.length)] });

  if (!input.health.checkedAt && local.length) {
    findings.push({ id: 'unchecked', severity: 'note', params: [], fix: { kind: 'check' } });
  }

  // Problems first, then notes, each in the order found
  return findings.sort((a, b) => Number(b.severity === 'problem') - Number(a.severity === 'problem'));
}

/**
 * A report for an issue: this computer's facts, the measured speeds and the last trace lines. No words said or
 * heard are in it, only sizes and times.
 */
export function voiceReport(input: {
  entries: VoiceTraceEntry[];
  health: VoiceHealth;
  findings: VoiceFinding[];
  version: string;
  userAgent: string;
}): string {
  const { health } = input;
  const speedLine = (label: string, speeds: Record<string, { speed: number; source: string } | undefined>) =>
    Object.entries(speeds)
      .filter(([, value]) => value)
      .map(([engine, value]) => `${label} ${engine}: ${value!.speed}× (${value!.source})`)
      .join('; ') || `${label}: not measured`;
  const lines = [
    `Ava ${input.version}, ${input.userAgent}`,
    health.machine
      ? `Computer: ${health.machine.cores} cores, ${health.machine.memoryGb ?? 'unknown'} GB reported, WebGPU ${health.machine.webgpu ? 'yes' : 'no'}, threads ${health.machine.threads ? 'yes' : 'no'}`
      : 'Computer: not checked',
    speedLine('Speaking', health.tts),
    speedLine('Hearing', health.stt),
    '',
    'Findings:',
    ...(input.findings.length
      ? input.findings.map(finding => `- ${finding.severity}: ${finding.id} (${finding.params.join(', ')})`)
      : ['- none']),
    '',
    'Last voice events (newest last; sizes and times only):',
    '| when | kind | engine | ok | chars | audio s | work ms | speed | first sound ms | pauses (n / total ms / longest ms) | note |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...input.entries
      .slice(-15)
      .map(entry =>
        [
          new Date(entry.at).toISOString(),
          entry.kind,
          entry.engine,
          entry.ok ? 'yes' : 'no',
          entry.chars ?? '',
          entry.audioSeconds ?? '',
          entry.workMs ?? '',
          entry.speed ?? '',
          entry.firstAudioMs ?? '',
          entry.gaps ? `${entry.gaps.count} / ${entry.gaps.totalMs} / ${entry.gaps.longestMs}` : '',
          entry.note ?? '',
        ].join(' | '),
      )
      .map(row => `| ${row} |`),
  ];
  return lines.join('\n');
}
