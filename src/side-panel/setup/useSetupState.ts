import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { setupStore } from '@src/background/setup/state';
import type { SetupItemId, SetupItemState, SetupProblem, SetupState } from '@src/background/setup/state';

/** The background's last setup check, kept current while it changes (the background is its only writer). */
export function useSetupState(): SetupState | null {
  const [state, setState] = useState<SetupState | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void setupStore.getState().then(next => alive && setState(next));
    load();
    const stop = setupStore.subscribe(load);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return state;
}

type MessageKey = Parameters<typeof t>[0];

export const ITEM_TITLES: Record<SetupItemId, MessageKey> = {
  model: 'setup_item_model',
  local: 'setup_item_local',
  voice: 'setup_item_voice',
  brain: 'setup_item_brain',
  ava: 'setup_item_ava',
  whatsapp: 'setup_item_whatsapp',
  calendar: 'setup_item_calendar',
  obsidian: 'setup_item_obsidian',
  backup: 'setup_item_backup',
};

const PROBLEMS: Record<SetupProblem, MessageKey> = {
  model_missing: 'setup_problem_model_missing',
  local_off: 'setup_problem_local_off',
  local_not_added: 'setup_problem_local_not_added',
  local_no_chat: 'setup_problem_local_no_chat',
  local_no_embed: 'setup_problem_local_no_embed',
  voice_missing: 'setup_problem_voice_missing',
  brain_unreachable: 'setup_problem_brain_unreachable',
  brain_unpaired: 'setup_problem_brain_unpaired',
  brain_offline: 'setup_problem_brain_offline',
  needs_brain: 'setup_problem_needs_brain',
  ava_no_browser: 'setup_problem_ava_no_browser',
  ava_signed_out: 'setup_problem_ava_signed_out',
  ava_unchecked: 'setup_problem_ava_unchecked',
  wa_not_linked: 'setup_problem_wa_not_linked',
  cal_none: 'setup_problem_cal_none',
  cal_error: 'setup_problem_cal_error',
  obs_none: 'setup_problem_obs_none',
  backup_never: 'setup_problem_backup_never',
  backup_failed: 'setup_problem_backup_failed',
};

/** The one line that says what is wrong (or, when ready, what is in use). */
export function itemLine(item: SetupItemState, name: string): string {
  if (item.problem) return t(PROBLEMS[item.problem], [name]);
  switch (item.id) {
    case 'local':
      return item.detail ? t('setup_detail_local', [item.detail]) : t('setup_ready');
    case 'ava':
      return item.detail ? t('setup_detail_ava', [item.detail]) : t('setup_detail_avaSignedIn', [name]);
    case 'calendar':
      return t(item.detail === 'mac' ? 'setup_detail_calendar_mac' : 'setup_detail_calendar_ics');
    case 'obsidian':
      return item.detail ? t('setup_detail_obsidian', [item.detail]) : t('setup_ready');
    case 'backup': {
      const at = Number(item.detail);
      return Number.isFinite(at) && at > 0
        ? t('setup_detail_backup', [new Date(at).toLocaleString()])
        : t('setup_ready');
    }
    default:
      return t('setup_ready');
  }
}
