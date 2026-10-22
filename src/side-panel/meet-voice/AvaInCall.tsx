import { useCallback, useEffect, useState } from 'react';
import { PiStopFill } from 'react-icons/pi';
import { t } from '@extension/i18n';
import type { MeetingRecord } from '@extension/storage';
import { brainSettingsStore } from '@src/background/companion/state';
import { meetVoiceStore } from '@src/background/meet-voice/state';
import type { MeetVoiceState } from '@src/background/meet-voice/state';
import { meetCodeOf } from '@src/shared/lib/protocol/companion';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import type { MeetStatus } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import { useAssistantName } from '../hooks/useAssistant';
import { sendMeetVoice } from './send';

/**
 * In a Google Meet call's notes: bring Ava into the call as her own participant (run by Nex Brain on the Mac), see
 * where she is (joining, waiting for the host, in the call, why it failed), stop her mid-sentence, and have her leave.
 * Without Nex Brain paired it says what she needs and links to its setup. The background does the talking; this reads
 * its stored state.
 */

const ACTIVE = new Set<MeetStatus['state']>(['joining', 'waiting_admission', 'in_call']);
const POLL_MS = 3000;

function useMeetVoice() {
  const [paired, setPaired] = useState(false);
  const [state, setState] = useState<MeetVoiceState | null>(null);
  useEffect(() => {
    const load = () => {
      void brainSettingsStore.getSettings().then(settings => setPaired(settings.paired));
      void meetVoiceStore.getState().then(setState);
    };
    load();
    const stopBrain = brainSettingsStore.subscribe(load);
    const stopState = meetVoiceStore.subscribe(load);
    return () => {
      stopBrain();
      stopState();
    };
  }, []);
  return { paired, state };
}

/** The state line, in the user's words. */
export function stateLine(status: MeetStatus | null, code: string | null, name: string): string {
  if (!status) return t('meetvoice_state_idle', [name]);
  if (ACTIVE.has(status.state) && status.meetingCode && status.meetingCode !== code) {
    return t('meetvoice_state_otherCall', [name]);
  }
  switch (status.state) {
    case 'signing_in':
      return t('meetvoice_state_signingIn', [name]);
    case 'joining':
      return t('meetvoice_state_joining', [name]);
    case 'waiting_admission':
      return t('meetvoice_state_waiting', [name]);
    case 'in_call':
      return status.speaking ? t('meetvoice_state_speaking', [name]) : t('meetvoice_state_inCall', [name]);
    case 'left':
      return t('meetvoice_state_left', [name, status.reason ?? '']);
    case 'failed':
      return t('meetvoice_state_failed', [name, status.reason ?? '']);
    default:
      return t('meetvoice_state_idle', [name]);
  }
}

export default function AvaInCall({ meeting }: { meeting: MeetingRecord }) {
  const { paired, state } = useMeetVoice();
  const name = useAssistantName();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const code = meetCodeOf(meeting.url);
  const status = state?.status ?? null;
  const active = status !== null && ACTIVE.has(status.state);
  const inCall = code !== null && meeting.status === 'recording';
  const shown = paired && inCall;

  const run = useCallback(async (type: string, extra: Record<string, unknown> = {}) => {
    setBusy(type);
    setError(null);
    try {
      await sendMeetVoice({ type, ...extra });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  }, []);

  // A fresh answer when the card shows, and every few seconds while she is on her way in or in the call
  useEffect(() => {
    if (!shown) return;
    void sendMeetVoice({ type: 'meetvoice_status' }).catch(() => {});
  }, [shown]);
  useEffect(() => {
    if (!shown || !(active || status?.state === 'signing_in')) return;
    const timer = setInterval(() => void sendMeetVoice({ type: 'meetvoice_status' }).catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [shown, active, status?.state]);

  if (!inCall) return null;
  if (!paired) {
    return (
      <section aria-labelledby="ava-in-call" className="glass mt-2.5 rounded-2xl p-3 text-[13px]">
        <h3 id="ava-in-call" className="mb-1 text-sm font-semibold">
          {t('meetvoice_title', [name])}
        </h3>
        <p className="text-muted-foreground">{t('meetvoice_needsBrain', [name])}</p>
        <Button size="sm" className="mt-2" onClick={() => void openSettingsPage('#connections/brain')}>
          {t('meetvoice_setUpBrain')}
        </Button>
      </section>
    );
  }
  const here = active && status?.meetingCode === code;
  const elsewhere = active && !here;

  return (
    <section aria-labelledby="ava-in-call" className="glass mt-2.5 rounded-2xl p-3 text-[13px]">
      <h3 id="ava-in-call" className="mb-1 text-sm font-semibold">
        {t('meetvoice_title', [name])}
      </h3>
      <p role="status" aria-live="polite" className={status?.state === 'failed' ? 'text-destructive' : ''}>
        {stateLine(status, code, name)}
      </p>
      {status && !status.browserFound && (
        <p className="text-muted-foreground mt-1 text-xs">{t('meetvoice_noBrowser')}</p>
      )}
      {status?.signedIn === false && !active && (
        <p className="text-muted-foreground mt-1 text-xs">{t('meetvoice_signedOut', [name])}</p>
      )}
      {(error || state?.error) && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error || state?.error}
        </p>
      )}
      {state?.offer?.meetingId === meeting.id && !active && (
        <div
          role="group"
          aria-label={t('meetvoice_offer_title', [name])}
          data-testid="meetvoice-offer"
          className="border-hold/60 bg-hold/10 mt-2 rounded-xl border p-2.5">
          <p className="text-[12.5px] font-medium">{t('meetvoice_offer_title', [name])}</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              variant="hold"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('meetvoice_join', { meetingId: meeting.id })}>
              {t('meetvoice_offer_yes', [name])}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('meetvoice_offer_dismiss')}>
              {t('meetvoice_offer_no')}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {here && status?.speaking && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void run('meetvoice_stop')}
            aria-keyshortcuts="Escape"
            className="gap-1.5">
            <PiStopFill size={12} aria-hidden="true" />
            {t('meetvoice_stop')}
          </Button>
        )}
        {active ? (
          <Button variant="glass" size="sm" disabled={busy !== null} onClick={() => void run('meetvoice_leave')}>
            {t('meetvoice_leave', [name])}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null || status?.state === 'signing_in'}
            onClick={() => void run('meetvoice_join', { meetingId: meeting.id })}>
            {busy === 'meetvoice_join' ? t('meetvoice_state_joining', [name]) : t('meetvoice_bring', [name])}
          </Button>
        )}
        {!active && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('meetvoice_signin')}>
            {t('meetvoice_signin', [name])}
          </Button>
        )}
      </div>
      {elsewhere ? null : (
        <p className="text-muted-foreground mt-2 text-xs">
          {here && status?.speaking ? t('meetvoice_stopHint', [name]) : t('meetvoice_about', [name])}
        </p>
      )}
      {!active && <p className="text-muted-foreground mt-1 text-xs">{t('meetvoice_signinHint', [name])}</p>}
    </section>
  );
}
