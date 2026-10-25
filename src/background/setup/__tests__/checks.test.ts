import { describe, expect, it } from 'vitest';
import type { MeetStatus } from '@src/shared/lib/protocol/companion';
import { evaluateSetup, pickLocalChat } from '../checks';
import type { SetupReadings } from '../checks';
import { pendingCount } from '../state';
import type { SetupItemId } from '../state';

const meet = (changes: Partial<MeetStatus> = {}): MeetStatus => ({
  state: 'idle',
  reason: null,
  meetingCode: null,
  speaking: false,
  signedIn: true,
  browserFound: true,
  since: 1,
  account: 'ava@example.com',
  ...changes,
});

const ready = (): SetupReadings => ({
  hasWorkingModel: true,
  local: {
    kind: 'ollama',
    providerId: 'ollama',
    saved: true,
    answers: true,
    root: 'http://localhost:11434',
    chatModels: ['gemma3:4b', 'qwen3:4b'],
    embed: true,
  },
  voice: { stt: true, tts: true },
  brain: { paired: true, state: 'online', reachable: true },
  ava: meet(),
  whatsapp: 'linked',
  calendar: { source: 'mac', error: null, configured: true },
  obsidian: { name: 'Notes' },
  backup: { lastBackupAt: 1000, lastError: null },
});

const problems = (readings: SetupReadings) =>
  Object.fromEntries(evaluateSetup(readings).map(item => [item.id, item.problem]));

describe('setup checks', () => {
  it('everything ready: no problem, and the details say what is in use', () => {
    const items = evaluateSetup(ready());
    expect(items.every(item => item.ready)).toBe(true);
    expect(items.find(item => item.id === 'local')?.detail).toBe('qwen3:4b');
    expect(items.find(item => item.id === 'ava')?.detail).toBe('ava@example.com');
    expect(pendingCount(items, [])).toBe(0);
  });

  it('says why the local model is not ready, in the order the user fixes it', () => {
    const base = ready();
    expect(problems({ ...base, local: { ...base.local, answers: false } }).local).toBe('local_off');
    expect(problems({ ...base, local: { ...base.local, saved: false } }).local).toBe('local_not_added');
    expect(problems({ ...base, local: { ...base.local, chatModels: [] } }).local).toBe('local_no_chat');
    expect(problems({ ...base, local: { ...base.local, embed: false } }).local).toBe('local_no_embed');
  });

  it('Ava Brain: install, pair, or start again', () => {
    const base = ready();
    expect(problems({ ...base, brain: { paired: false, state: 'unpaired', reachable: false } }).brain).toBe(
      'brain_unreachable',
    );
    expect(problems({ ...base, brain: { paired: false, state: 'unpaired', reachable: true } }).brain).toBe(
      'brain_unpaired',
    );
    const offline = problems({ ...base, brain: { paired: true, state: 'offline', reachable: false } });
    expect(offline.brain).toBe('brain_offline');
    // What runs on Ava Brain waits for it, and says so
    expect(offline.ava).toBe('needs_brain');
    expect(offline.whatsapp).toBe('needs_brain');
  });

  it("Ava's account: signed out, not checked, no browser", () => {
    const base = ready();
    expect(problems({ ...base, ava: meet({ signedIn: false }) }).ava).toBe('ava_signed_out');
    expect(problems({ ...base, ava: meet({ signedIn: null }) }).ava).toBe('ava_unchecked');
    expect(problems({ ...base, ava: null }).ava).toBe('ava_unchecked');
    expect(problems({ ...base, ava: meet({ browserFound: false }) }).ava).toBe('ava_no_browser');
  });

  it('voice, calendar, Obsidian, backups and the model', () => {
    const base = ready();
    expect(problems({ ...base, voice: { stt: true, tts: false } }).voice).toBe('voice_missing');
    expect(problems({ ...base, calendar: { source: null, error: null, configured: false } }).calendar).toBe('cal_none');
    expect(problems({ ...base, calendar: { source: null, error: 'bad', configured: true } }).calendar).toBe(
      'cal_error',
    );
    expect(problems({ ...base, obsidian: { name: null } }).obsidian).toBe('obs_none');
    expect(problems({ ...base, backup: { lastBackupAt: null, lastError: null } }).backup).toBe('backup_never');
    expect(problems({ ...base, backup: { lastBackupAt: null, lastError: 'x' } }).backup).toBe('backup_failed');
    expect(problems({ ...base, hasWorkingModel: false }).model).toBe('model_missing');
  });

  it('the indicator counts required steps always, and recommended ones unless skipped', () => {
    const base = ready();
    const items = evaluateSetup({
      ...base,
      voice: { stt: false, tts: false },
      whatsapp: 'not_linked',
      obsidian: { name: null },
    });
    expect(pendingCount(items, [])).toBe(3);
    expect(pendingCount(items, ['whatsapp'] as SetupItemId[])).toBe(2);
    // A required step can't be skipped away
    expect(pendingCount(items, ['voice', 'whatsapp', 'obsidian'] as SetupItemId[])).toBe(1);
  });

  it('prefers the recommended local chat model', () => {
    expect(pickLocalChat(['gemma3:4b', 'qwen3:4b'])).toBe('qwen3:4b');
    expect(pickLocalChat(['gemma3:4b'])).toBe('gemma3:4b');
    expect(pickLocalChat([])).toBeNull();
  });
});
