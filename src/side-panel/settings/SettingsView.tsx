import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, SlidersHorizontal } from 'lucide-react';
import { t } from '@extension/i18n';
import { agentModelStore, allPersonalities, personalityStore, ttsSettingsStore } from '@extension/storage';
import type { ReadAloudMode } from '@extension/storage';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import { Button } from '../components/ui/button';
import { personalityName, usePersonalities } from '../personalities/usePersonalities';
import type { PanelApi } from '../registry';
import { ThemePicker } from './sections/GeneralSections';
import { SELECT, useStoreSettings } from './sections/ui';
import { WakeWordSection } from './sections/VoiceSections';

/**
 * Settings in the panel: only the few things changed often (wake word, read aloud, personality, the model, the
 * look), each with a way to the full-page Settings where everything else is, grouped by page.
 */

function More({ hash, label }: { hash: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openSettingsPage(hash)}
      aria-label={t('settings_quick_more', [label])}
      title={t('settings_quick_more', [label])}
      data-settings-more={hash}
      className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 shrink-0 items-center justify-center rounded-lg">
      <ArrowUpRight className="size-4" aria-hidden />
    </button>
  );
}

function Quick({ label, hash, children }: { label: string; hash: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-quick-setting={hash}>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h3 className="label-mono">{label}</h3>
        <More hash={hash} label={label} />
      </div>
      <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">{children}</div>
    </section>
  );
}

function ReadAloud() {
  const settings = useStoreSettings(ttsSettingsStore);
  if (!settings) return null;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <label htmlFor="quick-read-aloud" className="min-w-0 flex-1 text-[13px]">
        {t('speak_settings_readAloud_label')}
      </label>
      <select
        id="quick-read-aloud"
        value={settings.readAloud}
        onChange={event => void ttsSettingsStore.updateSettings({ readAloud: event.target.value as ReadAloudMode })}
        className={SELECT}>
        <option value="off">{t('speak_settings_readAloud_off')}</option>
        <option value="voice">{t('speak_settings_readAloud_voice')}</option>
        <option value="always">{t('speak_settings_readAloud_always')}</option>
      </select>
    </div>
  );
}

function ActivePersonality() {
  const state = usePersonalities();
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <label htmlFor="quick-personality" className="min-w-0 flex-1 text-[13px]">
        {t('settings_quick_personality')}
      </label>
      <select
        id="quick-personality"
        value={state.activeId}
        onChange={event => void personalityStore.setActive(event.target.value, null)}
        className={`${SELECT} max-w-[55%]`}>
        {allPersonalities(state).map(personality => (
          <option key={personality.id} value={personality.id}>
            {personalityName(personality)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModelInUse() {
  const [models, setModels] = useState<{ planner: string; navigator: string } | null>(null);
  useEffect(() => {
    const load = () =>
      void agentModelStore.getAllAgentModels().then(agents =>
        setModels({
          planner: agents.planner?.modelName ?? t('settings_model_none'),
          navigator: agents.navigator?.modelName ?? t('settings_model_none'),
        }),
      );
    load();
    return agentModelStore.subscribe(load);
  }, []);
  return (
    <div className="px-3 py-2.5" data-quick-model>
      <div className="text-[13px]">{t('settings_model')}</div>
      <div className="text-muted-foreground mt-0.5 truncate font-mono text-[11.5px]">
        {models ? t('settings_model_roles', [models.planner, models.navigator]) : '…'}
      </div>
    </div>
  );
}

interface SettingsViewProps {
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
  api: PanelApi;
}

export default function SettingsView({ onBack, api }: SettingsViewProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t('today_back')}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-2">
        <Quick label={t('settings_section_wake')} hash="#voice/wake">
          <WakeWordSection api={api} />
        </Quick>
        <Quick label={t('speak_settings_title')} hash="#voice/tts">
          <ReadAloud />
        </Quick>
        <Quick label={t('settings_page_personalities')} hash="#personalities">
          <ActivePersonality />
        </Quick>
        <Quick label={t('settings_page_models')} hash="#models">
          <ModelInUse />
        </Quick>
        <Quick label={t('settings_look')} hash="#general/theme">
          <ThemePicker />
        </Quick>

        <Button variant="glass" size="lg" onClick={() => void openSettingsPage('#general')} data-all-settings>
          <SlidersHorizontal className="size-4" />
          {t('settings_all')}
        </Button>
      </div>
    </div>
  );
}
