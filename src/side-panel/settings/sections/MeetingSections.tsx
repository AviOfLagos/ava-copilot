import { useState } from 'react';
import { t } from '@extension/i18n';
import { meetingSettingsStore } from '@extension/storage';
import type { MeetingSettingsConfig } from '@extension/storage';
import { Switch } from '../../components/ui/switch';
import type { PanelApi } from '../../registry';
import BriefSettings from '../BriefSettings';
import { NUMBER, Row, useStoreSettings } from './ui';

/** Meetings: notes on joining a call, the microphone, live captions, how often notes are summed up, the audio. */
export function MeetingsSection() {
  const settings = useStoreSettings(meetingSettingsStore);
  const [minutes, setMinutes] = useState<string | null>(null);
  if (!settings) return null;
  const update = (changes: Partial<MeetingSettingsConfig>) => void meetingSettingsStore.updateSettings(changes);
  const toggle = (key: 'autoNotes' | 'includeMic' | 'liveCaptions' | 'keepAudio', label: string, hint?: string) => (
    <Row title={label} hint={hint}>
      <Switch label={label} checked={settings[key]} onChange={value => update({ [key]: value })} />
    </Row>
  );
  return (
    <>
      {toggle('autoNotes', t('settings_meetings_auto'), t('settings_meetings_auto_hint'))}
      {toggle('includeMic', t('options_meetings_includeMic'), t('options_meetings_includeMic_desc'))}
      {toggle('liveCaptions', t('options_meetings_liveCaptions'), t('options_meetings_liveCaptions_desc'))}
      <Row
        title={t('options_meetings_summaryMinutes')}
        hint={t('options_meetings_summaryMinutes_desc')}
        htmlFor="settings-meeting-summary">
        <input
          id="settings-meeting-summary"
          type="number"
          min={0.5}
          max={15}
          step={0.5}
          value={minutes ?? settings.summaryEverySeconds / 60}
          onChange={event => {
            setMinutes(event.target.value);
            const value = Number.parseFloat(event.target.value);
            if (Number.isFinite(value) && value >= 0.5) update({ summaryEverySeconds: Math.round(value * 60) });
          }}
          onBlur={() => setMinutes(null)}
          className={NUMBER}
        />
      </Row>
      {toggle('keepAudio', t('options_meetings_keepAudio'), t('options_meetings_keepAudio_desc'))}
    </>
  );
}

/** The morning brief; "Make one now" opens the chat it made. */
export function BriefSection({ api }: { api: PanelApi }) {
  return <BriefSettings onOpen={threadId => api.openThread(threadId)} />;
}
