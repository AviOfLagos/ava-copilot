import { useState } from 'react';
import { t } from '@extension/i18n';
import { RECORDING_MAX_MINUTES, recordingSettingsStore } from '@extension/storage';
import { NUMBER, Row, useStoreSettings } from '../settings/sections/ui';

/** Settings › Meetings › Screen recordings: how long one may run. */
export default function RecordingSettings() {
  const settings = useStoreSettings(recordingSettingsStore);
  const [minutes, setMinutes] = useState<string | null>(null);
  if (!settings) return null;
  return (
    <Row title={t('recording_settings_max')} hint={t('recording_settings_max_hint')} htmlFor="settings-recording-max">
      <input
        id="settings-recording-max"
        type="number"
        min={RECORDING_MAX_MINUTES.min}
        max={RECORDING_MAX_MINUTES.max}
        step={1}
        value={minutes ?? settings.maxMinutes}
        onChange={event => {
          setMinutes(event.target.value);
          const value = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(value) && value >= RECORDING_MAX_MINUTES.min) {
            void recordingSettingsStore.updateSettings({ maxMinutes: value });
          }
        }}
        onBlur={() => setMinutes(null)}
        className={NUMBER}
      />
    </Row>
  );
}
