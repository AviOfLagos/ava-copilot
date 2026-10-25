import type { MeetStatus, WhatsAppState } from '@src/shared/lib/protocol/companion';
import type { BrainState } from '../companion/state';
import type { SetupItemState, SetupProblem } from './state';

/**
 * Whether each part of the setup is ready, from readings of the real status (./readers.ts takes them). No storage
 * and no network here, so every rule can be tested on its own.
 */

export interface LocalReading {
  // The local server found: the saved one first, else one answering on its usual port
  kind: 'ollama' | 'lmstudio' | null;
  providerId: string | null;
  // Saved in Models (a provider the extension uses)
  saved: boolean;
  answers: boolean;
  root: string | null;
  chatModels: string[];
  embed: boolean;
}

export interface SetupReadings {
  hasWorkingModel: boolean;
  local: LocalReading;
  voice: { stt: boolean; tts: boolean };
  brain: { paired: boolean; state: BrainState; reachable: boolean };
  // Ava Brain's last answer about Ava's meeting browser (null: none yet)
  ava: MeetStatus | null;
  whatsapp: WhatsAppState | null;
  calendar: { source: 'mac' | 'ics' | null; error: string | null; configured: boolean };
  obsidian: { name: string | null };
  backup: { lastBackupAt: number | null; lastError: string | null };
}

// The chat model the local item names (and sets for light work): the recommended one when it is there
export const PREFERRED_LOCAL_CHAT = 'qwen3:4b';

export function pickLocalChat(models: string[]): string | null {
  const full = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return models.find(name => full(name) === full(PREFERRED_LOCAL_CHAT)) ?? models[0] ?? null;
}

const item = (
  id: SetupItemState['id'],
  problem: SetupProblem | null,
  detail: string | null = null,
): SetupItemState => ({ id, ready: problem === null, problem, detail });

function localItem(local: LocalReading): SetupItemState {
  if (!local.answers) return item('local', 'local_off');
  if (!local.saved) return item('local', 'local_not_added');
  if (!local.chatModels.length) return item('local', 'local_no_chat');
  if (!local.embed) return item('local', 'local_no_embed', pickLocalChat(local.chatModels));
  return item('local', null, pickLocalChat(local.chatModels));
}

function brainItem(brain: SetupReadings['brain']): SetupItemState {
  if (brain.paired) return item('brain', brain.state === 'online' ? null : 'brain_offline');
  return item('brain', brain.reachable ? 'brain_unpaired' : 'brain_unreachable');
}

function avaItem(status: MeetStatus | null): SetupItemState {
  if (!status) return item('ava', 'ava_unchecked');
  if (!status.browserFound) return item('ava', 'ava_no_browser');
  if (status.signedIn === true) return item('ava', null, status.account ?? null);
  return item('ava', status.signedIn === false ? 'ava_signed_out' : 'ava_unchecked');
}

export function evaluateSetup(readings: SetupReadings): SetupItemState[] {
  const brainOnline = readings.brain.paired && readings.brain.state === 'online';
  const { calendar, backup } = readings;
  return [
    item('model', readings.hasWorkingModel ? null : 'model_missing'),
    localItem(readings.local),
    item('voice', readings.voice.stt && readings.voice.tts ? null : 'voice_missing'),
    brainItem(readings.brain),
    brainOnline ? avaItem(readings.ava) : item('ava', 'needs_brain'),
    brainOnline
      ? item('whatsapp', readings.whatsapp === 'linked' ? null : 'wa_not_linked')
      : item('whatsapp', 'needs_brain'),
    calendar.source && !calendar.error
      ? item('calendar', null, calendar.source)
      : item('calendar', calendar.configured && calendar.error ? 'cal_error' : 'cal_none'),
    item('obsidian', readings.obsidian.name ? null : 'obs_none', readings.obsidian.name),
    backup.lastBackupAt
      ? item('backup', null, String(backup.lastBackupAt))
      : item('backup', !readings.brain.paired ? 'needs_brain' : backup.lastError ? 'backup_failed' : 'backup_never'),
  ];
}
