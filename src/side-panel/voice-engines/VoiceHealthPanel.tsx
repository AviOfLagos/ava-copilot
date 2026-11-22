import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import {
  diagnoseVoice,
  presetChanges,
  voiceEngineSettingsStore,
  voiceHealthStore,
  voiceReport,
  voiceTraceStore,
} from '@extension/storage';
import type { VoiceFinding, VoiceHealth, VoiceTraceEntry } from '@extension/storage';
import type { PanelApi } from '../registry';

const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';
const HINT = 'text-muted-foreground text-[11.5px]';
const BUTTON =
  'glass inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';

// The project's issues, where a report goes when the user chooses to send one
const ISSUES_URL = 'https://github.com/AviOfLagos/ava-copilot/issues/new';

const ENGINES: Record<string, Parameters<typeof t>[0]> = {
  kitten: 'voice_engine_name_kitten',
  kokoro: 'voice_engine_name_kokoro',
  moonshine: 'voice_engine_name_moonshine',
  whisper: 'voice_engine_name_whisper',
  vosk: 'voice_engine_name_vosk',
};

/** One finding as a sentence, from its code and figures. */
export function findingText(finding: VoiceFinding): { title: string; detail?: string } {
  const [a = '', b = ''] = finding.params;
  const engine = ENGINES[a] ? t(ENGINES[a]) : a;
  switch (finding.id) {
    case 'tts-slower-than-speech':
      return {
        title: t('voice_finding_slower_title', [engine, b]),
        detail: t('voice_finding_slower_detail'),
      };
    case 'tts-pauses':
      return { title: t('voice_finding_pauses_title', [a, b]), detail: t('voice_finding_pauses_detail') };
    case 'tts-slow-start':
      return { title: t('voice_finding_slowStart_title', [a]) };
    case 'tts-failing':
      return { title: t('voice_finding_failing_title', [a]) };
    case 'stt-slow':
      return { title: t('voice_finding_sttSlow_title', [engine, b]) };
    case 'fallback-used':
      return { title: t('voice_finding_fallback_title', [a]) };
    case 'unchecked':
      return { title: t('voice_finding_unchecked_title') };
  }
}

/**
 * Settings › Voice engines › What I noticed: what the voice trace says went wrong, found by code from measured times
 * (no model is asked), with the fix one click away. The report beside it holds sizes and times only, so it can be
 * pasted into an issue without a word of anything said or heard.
 */
export default function VoiceHealthPanel({ api }: { api: PanelApi }) {
  const [entries, setEntries] = useState<VoiceTraceEntry[] | null>(null);
  const [health, setHealth] = useState<VoiceHealth | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void voiceTraceStore.getEntries().then(setEntries);
    load();
    return voiceTraceStore.subscribe(load);
  }, []);
  useEffect(() => {
    const load = () => void voiceHealthStore.getHealth().then(setHealth);
    load();
    return voiceHealthStore.subscribe(load);
  }, []);

  if (!entries || !health) return null;
  const findings = diagnoseVoice({ entries, health });
  const report = () =>
    voiceReport({
      entries,
      health,
      findings,
      version: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    });

  const fix = async (finding: VoiceFinding) => {
    if (finding.fix?.kind === 'preset') {
      const { engine, tts } = presetChanges(finding.fix.preset);
      await voiceEngineSettingsStore.updateSettings(engine);
      await voiceEngineSettingsStore.setTtsEngine(tts);
      setNote(t('voice_health_fixed'));
    } else if (finding.fix?.kind === 'check') {
      setNote(t('voice_health_checking'));
      await api.request({ type: 'voice_engine_check' }, 300_000).catch(() => undefined);
      setNote(null);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(report());
    setNote(t('voice_health_copied'));
  };

  const issue = () => {
    const body = `${report()}\n\n<!-- What happened, in a sentence or two: -->\n`;
    // The address holds the title and the report; GitHub shows it for the user to read and send, or not
    const url = `${ISSUES_URL}?title=${encodeURIComponent('Voice: ' + (findings[0]?.id ?? 'something is slow'))}&body=${encodeURIComponent(body.slice(0, 5000))}`;
    void chrome.tabs.create({ url });
  };

  return (
    <div className={ROW}>
      <div className="text-[13px]">{t('voice_health_title')}</div>
      {!entries.length ? (
        <p className={HINT} data-testid="voice-health-empty">
          {t('voice_health_empty')}
        </p>
      ) : !findings.length ? (
        <p className={HINT} data-testid="voice-health-ok">
          {t('voice_health_ok')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('voice_health_title')}>
          {findings.map(finding => {
            const text = findingText(finding);
            return (
              <li
                key={`${finding.id}-${finding.params.join('-')}`}
                data-testid={`voice-finding-${finding.id}`}
                className="glass flex flex-col gap-1 rounded-lg px-2.5 py-2">
                <span className={finding.severity === 'problem' ? 'text-destructive text-[12.5px]' : 'text-[12.5px]'}>
                  {text.title}
                </span>
                {text.detail && <span className={HINT}>{text.detail}</span>}
                {finding.fix && (
                  <div>
                    <button type="button" className={BUTTON} onClick={() => void fix(finding)}>
                      {finding.fix.kind === 'check' ? t('voice_check_button') : t('voice_health_useInstant')}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {note && (
        <p role="status" className={HINT}>
          {note}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={BUTTON} disabled={!entries.length} onClick={() => void copy()}>
          {t('voice_health_copy')}
        </button>
        <button type="button" className={BUTTON} disabled={!entries.length} onClick={issue}>
          {t('voice_health_issue')}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={!entries.length}
          onClick={() => void voiceTraceStore.clear().then(() => setNote(null))}>
          {t('voice_health_clear')}
        </button>
      </div>
      <p className={HINT}>{t('voice_health_privacy')}</p>
    </div>
  );
}
