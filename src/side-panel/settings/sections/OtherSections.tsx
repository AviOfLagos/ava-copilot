import { useCallback, useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { t } from '@extension/i18n';
import { tracingSettingsStore } from '@extension/storage';
import { FirewallSettings } from '../../../options/components/FirewallSettings';
import { SkillsSettings } from '../../../options/components/SkillsSettings';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import HelpView from '../../help/HelpView';
import type { Place } from '../../layout/Sidebar';
import { ModelsHub } from '../../models/ModelsPage';
import type { PanelApi } from '../../registry';
import {
  brainRequirement,
  embedRequirement,
  obsidianRequirement,
  voiceFeatureRequirement,
} from '../../requirements/catalog';
import type { Requirement } from '../../requirements/flow';
import { RequirementCard, sizeText, useRequirementFlow } from '../../requirements/RequirementCard';
import { Switch } from '../../components/ui/switch';
import { HINT, Row, useStoreSettings } from './ui';

/** Models: the same Models page as the panel's (providers, roles, local models, the cloud fallback, usage). */
export function ModelsSection({ api, anchor }: { api: PanelApi; anchor?: string }) {
  return (
    <div className="-mx-3">
      <ModelsHub request={api.request} wide initialTab={anchor?.split('/')[0]} />
    </div>
  );
}

/** Blocked and allowed sites (the upstream firewall), in the page's glass. */
export function FirewallSection() {
  return (
    <div data-legacy className="p-1">
      <FirewallSettings isDarkMode />
    </div>
  );
}

export function SkillsSection() {
  return (
    <div data-legacy className="p-1">
      <SkillsSettings isDarkMode />
    </div>
  );
}

// Where a help answer's place is on this page, when it is a settings place
const SETTINGS_PLACES: Partial<Record<Place, string>> = {
  settings: 'general',
  models: 'models',
  skills: 'privacy/skills',
};

/** "How do I…": every everyday task, searchable, with a way straight there. */
export function HelpTasksSection({ api }: { api: PanelApi }) {
  return (
    <div className="flex flex-col [&>div]:p-2">
      <HelpView
        focusSearch={false}
        onGo={place => {
          const here = SETTINGS_PLACES[place];
          if (here && document.location.pathname.endsWith('options.html')) document.location.hash = here;
          else api.go(place);
        }}
      />
    </div>
  );
}

interface Installable {
  key: string;
  label: Parameters<typeof t>[0];
  make: (api: PanelApi) => Promise<Requirement> | Requirement;
}

const INSTALLABLES: Installable[] = [
  { key: 'talk', label: 'settings_install_talk', make: api => voiceFeatureRequirement('talk', api.request) },
  { key: 'wake', label: 'settings_install_wake', make: api => voiceFeatureRequirement('wake', api.request) },
  { key: 'embed', label: 'settings_install_embed', make: () => embedRequirement() },
  { key: 'brain', label: 'settings_install_brain', make: () => brainRequirement() },
  { key: 'obsidian', label: 'settings_install_obsidian', make: () => obsidianRequirement() },
];

function InstallRow({ item, api }: { item: Installable; api: PanelApi }) {
  const { flow, state } = useRequirementFlow();
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  const check = useCallback(async () => {
    try {
      const next = await item.make(api);
      setRequirement(next);
      setReady(await next.isReady());
    } catch {
      setReady(false);
    }
    // The api object is new on every panel render; the check only needs the first
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    if (state.phase === 'idle') void check();
  }, [check, state.phase]);

  return (
    <li data-installable={item.key}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t(item.label)}</div>
          {requirement && (
            <div className={HINT}>
              {requirement.label}
              {requirement.sizeBytes ? ` · ${sizeText(requirement.sizeBytes)}` : ''}
            </div>
          )}
        </div>
        {ready ? (
          <Badge variant="default">
            <Check className="size-3" aria-hidden />
            {t('settings_install_ready')}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="glass"
            disabled={ready === null || state.phase !== 'idle'}
            aria-label={t('settings_install_named', [t(item.label)])}
            onClick={async () => {
              const fresh = await item.make(api);
              setRequirement(fresh);
              await flow.choose(fresh, () => setReady(true));
            }}>
            {t(requirement?.install === undefined && requirement ? 'settings_install_setUp' : 'requirement_install')}
          </Button>
        )}
      </div>
      <RequirementCard flow={flow} state={state} />
    </li>
  );
}

/** Everything that needs installing or setting up once, whether it is here, and Install for what is not. */
export function InstallOverviewSection({ api }: { api: PanelApi }) {
  return (
    <ul className="divide-border/60 divide-y" aria-label={t('settings_install_title')}>
      {INSTALLABLES.map(item => (
        <InstallRow key={item.key} item={item} api={api} />
      ))}
    </ul>
  );
}

/** Privacy: hosted tracing to Suture. Off unless switched on here; the text of chats is a second switch. */
export function TracingSection() {
  const settings = useStoreSettings(tracingSettingsStore);
  if (!settings) return null;
  return (
    <>
      <Row title={t('settings_tracing_on')} hint={t('settings_tracing_on_hint')}>
        <Switch
          label={t('settings_tracing_on')}
          checked={settings.hostedEnabled}
          onChange={hostedEnabled => void tracingSettingsStore.updateSettings({ hostedEnabled })}
        />
      </Row>
      <Row title={t('settings_tracing_content')} hint={t('settings_tracing_content_hint')}>
        <Switch
          label={t('settings_tracing_content')}
          checked={settings.captureContent}
          disabled={!settings.hostedEnabled}
          onChange={captureContent => void tracingSettingsStore.updateSettings({ captureContent })}
        />
      </Row>
    </>
  );
}
