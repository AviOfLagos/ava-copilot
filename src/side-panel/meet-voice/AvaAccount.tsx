import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { brainSettingsStore, brainStatusStore } from '@src/background/companion/state';
import type { BrainSettings, BrainStatus } from '@src/background/companion/state';
import { meetVoiceSettingsStore, meetVoiceStore } from '@src/background/meet-voice/state';
import type { MeetAutoJoin, MeetVoiceSettings, MeetVoiceState } from '@src/background/meet-voice/state';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import { Button } from '../components/ui/button';
import { useAssistantName } from '../hooks/useAssistant';
import type { PanelApi } from '../registry';
import { HINT, Row, SELECT } from '../settings/sections/ui';

/**
 * Settings › Meetings › Ava's meeting account: the browser Nex Brain runs her in, whether it is signed in and to which
 * account, the button that opens it at Google's sign-in (the user signs in there, by hand: the extension never sees or
 * keeps the password), and whether she joins the user's Google Meet calls by herself.
 */

function useLive<T>(store: { subscribe: (listener: () => void) => () => void }, read: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void read().then(next => alive && setValue(next));
    load();
    const stop = store.subscribe(load);
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
  return value;
}

const CHOICES: { value: MeetAutoJoin; label: Parameters<typeof t>[0] }[] = [
  { value: 'never', label: 'meetvoice_auto_never' },
  { value: 'ask', label: 'meetvoice_auto_ask' },
  { value: 'always', label: 'meetvoice_auto_always' },
];

export default function AvaAccount({ api }: { api: PanelApi }) {
  const name = useAssistantName();
  const brain = useLive<BrainSettings>(brainSettingsStore, () => brainSettingsStore.getSettings());
  const brainStatus = useLive<BrainStatus>(brainStatusStore, () => brainStatusStore.getStatus());
  const voice = useLive<MeetVoiceState>(meetVoiceStore, () => meetVoiceStore.getState());
  const settings = useLive<MeetVoiceSettings>(meetVoiceSettingsStore, () => meetVoiceSettingsStore.getSettings());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const paired = brain?.paired === true;
  useEffect(() => {
    if (paired) void api.request({ type: 'meetvoice_status' }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired]);

  const run = async (type: string, extra: Record<string, unknown> = {}, timeoutMs = 20_000) => {
    setBusy(type);
    setError('');
    try {
      await api.request({ type, ...extra }, timeoutMs);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(null);
    }
  };

  const status = voice?.status ?? null;
  const brainLine = !paired
    ? t('meetvoice_account_brainUnpaired')
    : brainStatus?.state === 'online'
      ? t('meetvoice_account_brainOnline')
      : t('meetvoice_account_brainOffline');
  const signedLine = !paired
    ? t('meetvoice_account_needsBrain', [name])
    : !status
      ? t('meetvoice_account_unknown', [name])
      : !status.browserFound
        ? t('meetvoice_noBrowser')
        : status.signedIn === true
          ? status.account
            ? t('meetvoice_account_signedInAs', [name, status.account])
            : t('meetvoice_account_signedIn', [name])
          : status.signedIn === false
            ? t('meetvoice_signedOut', [name])
            : t('meetvoice_account_unknown', [name]);

  return (
    <div data-testid="ava-account">
      <Row title={t('meetvoice_account_brain')} hint={brainLine}>
        {!paired && (
          <Button size="sm" variant="glass" onClick={() => void openSettingsPage('#connections/brain')}>
            {t('meetvoice_setUpBrain')}
          </Button>
        )}
      </Row>
      <Row
        title={t('meetvoice_account_browser', [name])}
        hint={
          <span
            role="status"
            data-ava-signed-in={status?.signedIn === true ? 'true' : status?.signedIn === false ? 'false' : 'unknown'}>
            {signedLine}
          </span>
        }>
        {paired && (
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button
              size="sm"
              variant="glass"
              disabled={busy !== null || status?.state === 'in_call'}
              onClick={() => void run('meetvoice_check', {}, 50_000)}>
              {busy === 'meetvoice_check' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t('meetvoice_account_check')}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void run('meetvoice_signin')}>
              {t('meetvoice_signin', [name])}
            </Button>
          </div>
        )}
      </Row>
      <p className={`${HINT} px-3 pb-1`}>{t('meetvoice_account_note', [name])}</p>
      <Row title={t('meetvoice_auto_title', [name])} hint={t('meetvoice_auto_hint', [name])} htmlFor="meetvoice-auto">
        <select
          id="meetvoice-auto"
          className={SELECT}
          value={settings?.autoJoin ?? 'never'}
          disabled={busy !== null}
          onChange={event => void run('meetvoice_settings', { autoJoin: event.target.value })}>
          {CHOICES.map(choice => (
            <option key={choice.value} value={choice.value}>
              {t(choice.label)}
            </option>
          ))}
        </select>
      </Row>
      {(error || voice?.error) && (
        <p role="alert" className="text-destructive px-3 pb-2.5 text-[11.5px]">
          {error || voice?.error}
        </p>
      )}
    </div>
  );
}
