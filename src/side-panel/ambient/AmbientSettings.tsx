import { useState } from 'react';
import { t } from '@extension/i18n';
import { ambientSettingsStore, db } from '@extension/storage';
import type { AmbientMode, AmbientSession, AmbientUtterance } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { voiceFeatureRequirement } from '../requirements/catalog';
import { RequirementCard, useRequirementFlow } from '../requirements/RequirementCard';
import { HINT, Row, SELECT, useStoreSettings } from '../settings/sections/ui';

/**
 * Settings › Ambient (docs/ambient-plan.md, A1): whether Ava writes down what is said around the Mac, off the record,
 * forgetting the last minutes, whether a cloud model may use any of it, and what she heard lately. Changes go
 * through the background ('ambient_set'), which starts or stops the listener and says why it could not.
 */

const FORGET_MINUTES = 10;
const RECENT_SESSIONS = 5;

type Reply = { error?: string; micDenied?: boolean };

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function errorText(reply: Reply): string {
  if (reply.micDenied) return t('ambient_error_mic');
  if (reply.error === 'missing_stt') return t('ambient_error_stt');
  return reply.error ? t('ambient_error_start', [reply.error]) : '';
}

function RecentSession({ session }: { session: AmbientSession }) {
  const [open, setOpen] = useState(false);
  const lines = useLive<AmbientUtterance[]>(
    () =>
      open
        ? db.ambientUtterances
            .where('[sessionId+startedAt]')
            .between([session.id, -Infinity], [session.id, Infinity])
            .toArray()
        : Promise.resolve([]),
    [open, session.id, session.utteranceCount],
    [],
  );
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        className="text-left text-[12.5px] hover:underline"
        onClick={() => setOpen(!open)}>
        {t('ambient_recent_session', [
          new Date(session.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          timeOf(session.startedAt),
          timeOf(session.endedAt),
          String(session.utteranceCount),
        ])}
      </button>
      {open && (
        <ul className="border-input flex flex-col gap-0.5 border-l pl-2.5">
          {lines.map(line => (
            <li key={line.id} className="text-[12px]">
              <span className="text-muted-foreground font-mono text-[10.5px]">{timeOf(line.startedAt)}</span>{' '}
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function AmbientSettings({ api }: { api: PanelApi }) {
  const settings = useStoreSettings(ambientSettingsStore);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const { flow, state } = useRequirementFlow();
  const sessions = useLive(
    () => db.ambientSessions.orderBy('startedAt').reverse().limit(RECENT_SESSIONS).toArray(),
    [],
    [] as AmbientSession[],
  );
  if (!settings) return null;

  const set = async (changes: { mode?: AmbientMode; offRecord?: boolean; cloudAllowed?: boolean }) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const reply = await api.request<Reply>({ type: 'ambient_set', ...changes });
      setError(errorText(reply));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const chooseMode = async (mode: AmbientMode) => {
    if (mode === 'off') {
      await set({ mode });
      return;
    }
    // A recogniser on this Mac first: ambient listening never uses a cloud one
    const requirement = await voiceFeatureRequirement('ambient', api.request);
    await flow.choose(requirement, () => set({ mode }));
  };

  const forget = async () => {
    setNotice('');
    const reply = await api
      .request<{ removed?: number; changed?: number }>({ type: 'ambient_forget', minutes: FORGET_MINUTES })
      .catch(() => null);
    setNotice(reply ? t('ambient_forgot', [String(FORGET_MINUTES)]) : t('ambient_forget_failed'));
  };

  const on = settings.mode !== 'off';

  return (
    <>
      <Row title={t('ambient_mode')} htmlFor="ambient-mode" hint={error || t('ambient_mode_hint')}>
        <select
          id="ambient-mode"
          className={SELECT}
          value={settings.mode}
          disabled={busy || state.phase !== 'idle'}
          onChange={event => void chooseMode(event.target.value as AmbientMode)}>
          <option value="off">{t('ambient_mode_off')}</option>
          <option value="listen">{t('ambient_mode_listen')}</option>
          <option value="companion">{t('ambient_mode_companion')}</option>
        </select>
      </Row>
      <RequirementCard flow={flow} state={state} />
      {on && (
        <Row
          title={t('ambient_offRecord')}
          hint={
            settings.offRecord && settings.offRecordSince
              ? t('ambient_offRecord_since', [timeOf(settings.offRecordSince)])
              : t('ambient_offRecord_hint')
          }>
          <Switch
            label={t('ambient_offRecord')}
            checked={settings.offRecord}
            disabled={busy}
            onChange={value => void set({ offRecord: value })}
          />
        </Row>
      )}
      <Row title={t('ambient_cloud')} hint={t('ambient_cloud_hint')}>
        <Switch
          label={t('ambient_cloud')}
          checked={settings.cloudAllowed}
          disabled={busy}
          onChange={value => void set({ cloudAllowed: value })}
        />
      </Row>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px]">{t('ambient_recent')}</div>
          <Button variant="outline" size="sm" onClick={() => void forget()} disabled={sessions.length === 0}>
            {t('ambient_forget', [String(FORGET_MINUTES)])}
          </Button>
        </div>
        {notice && (
          <p className={HINT} role="status">
            {notice}
          </p>
        )}
        {sessions.length === 0 ? (
          <p className={HINT}>{t('ambient_recent_none')}</p>
        ) : (
          <ul aria-label={t('ambient_recent')} className="flex flex-col gap-1.5">
            {sessions.map(session => (
              <RecentSession key={session.id} session={session} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
