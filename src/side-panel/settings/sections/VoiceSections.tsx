import { useState } from 'react';
import { t } from '@extension/i18n';
import { meetingSettingsStore } from '@extension/storage';
import { Switch } from '../../components/ui/switch';
import { displayPhrase, useAssistantName, useWakeChoice } from '../../hooks/useAssistant';
import { setWakeWord } from '../../onboarding/wake';
import type { PanelApi } from '../../registry';
import { voiceFeatureRequirement } from '../../requirements/catalog';
import { RequirementCard, useRequirementFlow } from '../../requirements/RequirementCard';
import { Row, SELECT, useStoreSettings } from './ui';

/**
 * The wake word: always listening on this computer for "Hey Ava". Its recogniser is downloaded the first time;
 * the switch turns on only once it is here (Cancel leaves it off).
 */
export function WakeWordSection({ api }: { api: PanelApi }) {
  const meeting = useStoreSettings(meetingSettingsStore);
  const [error, setError] = useState('');
  const { flow, state } = useRequirementFlow();
  const name = useAssistantName();
  const phrase = displayPhrase(useWakeChoice(name), name);
  if (!meeting) return null;

  const toggle = async (on: boolean) => {
    setError('');
    if (!on) {
      setError((await setWakeWord(false)) ?? '');
      return;
    }
    const requirement = await voiceFeatureRequirement('wake', api.request);
    await flow.choose(requirement, async () => {
      // The model is here: no second download card
      setError((await setWakeWord(true)) ?? '');
    });
  };

  return (
    <>
      <Row title={t('settings_wake', [phrase])} hint={error || t('settings_wake_hint', [phrase])}>
        <Switch
          label={t('settings_wake', [phrase])}
          checked={meeting.wakeWord}
          disabled={state.phase !== 'idle'}
          onChange={value => void toggle(value)}
        />
      </Row>
      <RequirementCard flow={flow} state={state} />
    </>
  );
}

const PATIENCE_CHOICES = [
  ['quick', 'settings_patience_quick'],
  ['normal', 'settings_patience_normal'],
  ['patient', 'settings_patience_patient'],
] as const;

/**
 * How long a pause may be before Ava takes the user to be finished and answers. Applies to a live (Gemini) voice
 * conversation; the on-device voice already waits for the end of a sentence.
 */
export function TurnPatienceSection() {
  const meeting = useStoreSettings(meetingSettingsStore);
  if (!meeting) return null;
  return (
    <Row title={t('settings_patience')} hint={t('settings_patience_hint')} htmlFor="settings-patience">
      <select
        id="settings-patience"
        className={SELECT}
        value={meeting.turnPatience}
        onChange={event =>
          void meetingSettingsStore.updateSettings({ turnPatience: event.target.value as typeof meeting.turnPatience })
        }>
        {PATIENCE_CHOICES.map(([value, label]) => (
          <option key={value} value={value}>
            {t(label)}
          </option>
        ))}
      </select>
    </Row>
  );
}
