/**
 * check_audio, decided by fixed rules (no model): which microphone and speaker are chosen, whether the microphone
 * hears anything over about two seconds, and a short test tone on the chosen speaker that the user is asked about.
 * The measuring happens in the offscreen document, the only page with microphone access (src/offscreen/audio-check.ts).
 */

export interface MicMeasurement {
  ok: boolean;
  // Root-mean-square level of each ~100 ms slice, 0…1
  levels: number[];
  // The microphone that actually opened (its label), which may be the system default when the chosen one is gone
  label?: string;
  error?: string;
  // The browser refused the microphone
  denied?: boolean;
}

export interface ToneResult {
  ok: boolean;
  label?: string;
  error?: string;
}

export type MicVerdict = 'hearing' | 'quiet' | 'silent' | 'denied' | 'failed';

// Digital silence (a muted mic, or one that delivers zeros)
const SILENT_PEAK = 0.002;
// Room noise and a distant voice sit between these; speech close to the mic is above QUIET_PEAK
const QUIET_PEAK = 0.02;

export function judgeMic(measurement: MicMeasurement): { verdict: MicVerdict; peak: number; average: number } {
  if (measurement.denied) return { verdict: 'denied', peak: 0, average: 0 };
  if (!measurement.ok || measurement.levels.length === 0) return { verdict: 'failed', peak: 0, average: 0 };
  const peak = Math.max(...measurement.levels);
  const average = measurement.levels.reduce((sum, level) => sum + level, 0) / measurement.levels.length;
  const verdict: MicVerdict = peak < SILENT_PEAK ? 'silent' : peak < QUIET_PEAK ? 'quiet' : 'hearing';
  return { verdict, peak, average };
}

/** The level as a word and a number the user can follow ("level 34 of 100"). */
function levelOf(peak: number): number {
  // Speech peaks around 0.1–0.5 RMS per slice; a square root spreads the low end out
  return Math.min(100, Math.round(Math.sqrt(peak) * 100));
}

export interface AudioReport {
  micChoice: string;
  speakerChoice: string;
  mic: MicMeasurement;
  tone: ToneResult;
  // Speaker choice cannot apply: the read-aloud voice is the system's (chrome.tts has no output device)
  systemVoice?: boolean;
}

/** What check_audio tells the model to say: plain sentences, and what to try when something is off. */
export function describeAudioCheck(report: AudioReport): string {
  const { verdict, peak } = judgeMic(report.mic);
  const opened = report.mic.label && report.mic.label !== report.micChoice ? ` (opened: ${report.mic.label})` : '';
  const lines = [`Microphone: ${report.micChoice}${opened}. Speaker: ${report.speakerChoice}.`];
  switch (verdict) {
    case 'hearing':
      lines.push(`I can hear you: the mic level went up to ${levelOf(peak)} of 100 over two seconds.`);
      break;
    case 'quiet':
      lines.push(
        `The mic hears only a little (level ${levelOf(peak)} of 100): speak closer, raise the input volume, or pick another mic in Settings › Audio devices.`,
      );
      break;
    case 'silent':
      lines.push(
        'Your mic is silent: nothing came in for two seconds. Check that it is not muted (on the device or in the system), or pick another one in Settings › Audio devices.',
      );
      break;
    case 'denied':
      lines.push(
        'The browser has not allowed the microphone. The user allows it from the prompt or the site settings.',
      );
      break;
    default:
      lines.push(
        `The mic could not be opened${report.mic.error ? `: ${report.mic.error}` : ''}. Pick another one in Settings › Audio devices.`,
      );
  }
  if (report.tone.ok) {
    lines.push(
      `A short test tone just played on ${report.tone.label || report.speakerChoice}. Ask the user whether they heard it; if not, check the volume or pick another speaker in Settings › Audio devices.`,
    );
  } else {
    lines.push(`The test tone could not play${report.tone.error ? `: ${report.tone.error}` : ''}.`);
  }
  if (report.systemVoice) {
    lines.push('Read-aloud uses a system voice, which always plays on the system default speaker.');
  }
  return lines.join('\n');
}
