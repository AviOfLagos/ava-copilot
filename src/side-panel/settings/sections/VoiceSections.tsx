import { useState } from 'react';
import { t } from '@extension/i18n';
import { meetingSettingsStore } from '@extension/storage';
import { Switch } from '../../components/ui/switch';
import { displayPhrase, useAssistantName, useWakeChoice } from '../../hooks/useAssistant';
import { setWakeWord } from '../../onboarding/wake';
import type { PanelApi } from '../../registry';
import { voiceFeatureRequirement } from '../../requirements/catalog';
import { RequirementCard, useRequirementFlow } from '../../requirements/RequirementCard';
import { Row, useStoreSettings } from './ui';

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
