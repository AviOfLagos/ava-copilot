import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import {
  COMMIT_KINDS,
  DENSITIES,
  TEXT_SCALES,
  accountProfileStore,
  appearanceSettingsStore,
  checkAssistantName,
  gateSettingsStore,
  generalSettingsStore,
  localDay,
  permissionRulesStore,
  usageStore,
} from '@extension/storage';
import type { CommitKind, Density, GeneralSettingsConfig, PermissionRule } from '@extension/storage';
import { Switch } from '../../components/ui/switch';
import { useAssistantName } from '../../hooks/useAssistant';
import { saveTheme, useTheme } from '../../layout/theme';
import type { ThemeChoice } from '../../layout/theme';
import { NameInput, WakeNote, nameError } from '../../onboarding/AssistantName';
import { HINT, NUMBER, Row, useStoreSettings } from './ui';

// General: who is who, the look, how it writes, what it shows, what waits for a click, and what it may spend

const KIND_LABELS: Record<CommitKind, Parameters<typeof t>[0]> = {
  send: 'gate_kind_send',
  publish: 'gate_kind_publish',
  submit: 'gate_kind_submit',
  delete: 'gate_kind_delete',
  purchase: 'gate_kind_purchase',
  permission: 'gate_kind_permission',
};

/** Your name and the assistant's (the wake word can follow it). */
export function NamesSection() {
  const [name, setName] = useState('');
  const assistantName = useAssistantName();
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    void accountProfileStore.getDisplayName().then(setName);
  }, []);

  // A valid name is saved when the field is left; an invalid one shows why and is not
  const save = async () => {
    const check = checkAssistantName(draft ?? '');
    if (draft === null || !check.ok) return;
    await generalSettingsStore.updateSettings({ assistantName: check.name });
    setDraft(null);
  };
  const value = draft ?? assistantName;
  const error = draft !== null ? nameError(draft) : '';

  return (
    <>
      <Row title={t('shell_settings_name')} htmlFor="settings-name">
        <input
          id="settings-name"
          type="text"
          value={name}
          placeholder={t('shell_profile_defaultName')}
          onChange={event => setName(event.target.value)}
          onBlur={() => void accountProfileStore.setDisplayName(name)}
          className="bg-card focus:border-primary/50 w-40 rounded-lg border px-2 py-1 text-right text-[12.5px] text-foreground outline-none"
        />
      </Row>
      <Row
        title={t('onboard_name_field')}
        hint={
          error ? (
            <span id="settings-assistant-error" className="text-destructive">
              {error}
            </span>
          ) : (
            <>
              {t('onboard_settings_name_hint')}
              <WakeNote name={value} className="mt-0.5" />
            </>
          )
        }>
        <NameInput
          id="settings-assistant-name"
          errorId="settings-assistant-error"
          value={value}
          onChange={setDraft}
          onBlur={() => void save()}
          className="w-40 px-2 py-1 text-right text-[12.5px]"
        />
      </Row>
    </>
  );
}

/** Dark, light, or what the system uses. */
export function ThemePicker({ className }: { className?: string }) {
  const { choice } = useTheme();
  return (
    <div role="radiogroup" aria-label={t('settings_look')} className={cn('grid grid-cols-3 gap-1 p-1', className)}>
      {(['dark', 'light', 'system'] as ThemeChoice[]).map(option => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={choice === option}
          onClick={() => saveTheme(option)}
          className={cn(
            'h-8 rounded-xl text-[12.5px] transition-colors',
            choice === option ? 'border bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}>
          {t(`settings_look_${option}`)}
        </button>
      ))}
    </div>
  );
}

/** Small / normal / large text, and how tight the spacing is. */
export function TextSizeControl() {
  const appearance = useStoreSettings(appearanceSettingsStore);
  const scale = appearance?.textScale ?? 100;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={TEXT_SCALES.length - 1}
        step={1}
        value={Math.max(0, TEXT_SCALES.indexOf(scale))}
        aria-label={t('settings_look_textSize')}
        aria-valuetext={`${scale}%`}
        onChange={event =>
          void appearanceSettingsStore.updateSettings({ textScale: TEXT_SCALES[Number(event.target.value)] })
        }
        className="accent-primary min-w-0 flex-1"
      />
      <span className="w-10 shrink-0 text-right font-mono text-[11.5px]">{scale}%</span>
    </div>
  );
}

export function DensityPicker() {
  const appearance = useStoreSettings(appearanceSettingsStore);
  const density = appearance?.density ?? 'comfortable';
  return (
    <div role="radiogroup" aria-label={t('settings_look_density')} className="grid grid-cols-3 gap-1">
      {DENSITIES.map((option: Density) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={density === option}
          onClick={() => void appearanceSettingsStore.updateSettings({ density: option })}
          className={cn(
            'h-8 rounded-xl text-[12.5px] transition-colors',
            density === option ? 'border bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}>
          {t(`settings_look_density_${option}`)}
        </button>
      ))}
    </div>
  );
}

export function ThemeSection() {
  return (
    <>
      <ThemePicker />
      <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-1">
        <div className="text-[13px]">{t('settings_look_textSize')}</div>
        <TextSizeControl />
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-3 pt-1">
        <div className="text-[13px]">{t('settings_look_density')}</div>
        <DensityPicker />
      </div>
    </>
  );
}

/** How it writes: a style the agent follows in everything it drafts. */
export function WritingStyleSection() {
  const settings = useStoreSettings(generalSettingsStore);
  const [draft, setDraft] = useState<string | null>(null);
  if (!settings) return null;
  return (
    <div className="p-3">
      <label htmlFor="settings-style" className="text-[13px]">
        {t('options_general_stylePrompt')}
      </label>
      <p className={`${HINT} mb-1.5`}>{t('options_general_stylePrompt_desc')}</p>
      <textarea
        id="settings-style"
        rows={3}
        value={draft ?? settings.stylePrompt}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== settings.stylePrompt) {
            void generalSettingsStore.updateSettings({ stylePrompt: draft });
          }
          setDraft(null);
        }}
        className="text-foreground focus:border-primary/50 w-full resize-y rounded-xl border bg-transparent p-2 text-[12.5px] leading-relaxed outline-none"
      />
    </div>
  );
}

export function HighlightsSection() {
  const settings = useStoreSettings(generalSettingsStore);
  if (!settings) return null;
  return (
    <Row title={t('settings_highlights')} hint={t('settings_highlights_hint')}>
      <Switch
        label={t('settings_highlights')}
        checked={settings.displayHighlights}
        onChange={value => void generalSettingsStore.updateSettings({ displayHighlights: value })}
      />
    </Row>
  );
}

/** The kinds of step that wait for the user's click (amber), and the ones let through. */
export function ConfirmSection() {
  const settings = useStoreSettings(gateSettingsStore);
  if (!settings) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 p-3">
        {COMMIT_KINDS.map(kind => (
          <button
            key={kind}
            type="button"
            aria-pressed={settings.confirm[kind] !== false}
            onClick={() => void gateSettingsStore.setConfirm(kind, settings.confirm[kind] === false)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
              settings.confirm[kind] !== false
                ? 'border-hold/50 bg-hold/15 text-hold-foreground'
                : 'border-input text-muted-foreground line-through',
            )}>
            {t(KIND_LABELS[kind])}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground px-3 pb-3 text-[11.5px]">{t('settings_gate_hint')}</p>
    </>
  );
}

/** What the user allowed every time, with a Remove for each. Money, deleting and access are never on it. */
export function PermissionsSection() {
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void permissionRulesStore.list().then(next => alive && setRules(next));
    load();
    const stop = permissionRulesStore.subscribe(load);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  if (!rules) return null;
  return (
    <>
      {rules.length === 0 ? (
        <p className="text-muted-foreground p-3 text-[12px]">{t('settings_permissions_empty')}</p>
      ) : (
        <ul className="divide-input divide-y">
          {rules.map(rule => (
            <li key={rule.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{rule.label}</div>
                <div className="text-muted-foreground text-[11px]">
                  {t('settings_permissions_used', [String(rule.uses), new Date(rule.createdAt).toLocaleDateString()])}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void permissionRulesStore.remove(rule.id)}
                className="border-input hover:bg-muted rounded-full border px-2.5 py-1 text-[12px]">
                {t('settings_permissions_remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground px-3 pb-3 text-[11.5px]">{t('settings_permissions_hint')}</p>
    </>
  );
}

/** What it may spend on models in a day, against what today cost so far. */
export function DailyCapSection() {
  const settings = useStoreSettings(generalSettingsStore);
  const [spent, setSpent] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    void usageStore.getDay(localDay()).then(day => setSpent(day.costUsd));
  }, []);
  if (!settings) return null;
  const cap = settings.dailyCostCapUsd;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor="settings-cap" className="text-[13px]">
            {t('settings_cap')}
          </label>
          <p className={HINT}>{t('options_general_dailyCap_desc')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-[12.5px]">
          <span className="text-muted-foreground">${spent.toFixed(2)} /</span>
          <span>$</span>
          <input
            id="settings-cap"
            type="number"
            min={0}
            step={0.5}
            value={draft ?? cap}
            onChange={event => {
              setDraft(event.target.value);
              const value = Number.parseFloat(event.target.value);
              if (Number.isFinite(value) && value >= 0) {
                void generalSettingsStore.updateSettings({ dailyCostCapUsd: value });
              }
            }}
            onBlur={() => setDraft(null)}
            className="bg-card focus:border-primary/50 w-16 rounded-md border px-1.5 py-0.5 text-right outline-none"
          />
        </div>
      </div>
      <div className="bg-muted mt-2.5 h-1.5 rounded">
        <div
          className="bg-primary h-1.5 rounded"
          style={{ width: `${Math.min(100, (spent / Math.max(cap, 0.01)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

type NumberKey = 'maxSteps' | 'maxActionsPerStep' | 'maxFailures' | 'planningInterval' | 'minWaitPageLoad';

const LIMITS: {
  key: NumberKey;
  label: Parameters<typeof t>[0];
  hint: Parameters<typeof t>[0];
  min: number;
  max: number;
  step?: number;
}[] = [
  { key: 'maxSteps', label: 'options_general_maxSteps', hint: 'options_general_maxSteps_desc', min: 1, max: 50 },
  {
    key: 'maxActionsPerStep',
    label: 'options_general_maxActions',
    hint: 'options_general_maxActions_desc',
    min: 1,
    max: 50,
  },
  {
    key: 'maxFailures',
    label: 'options_general_maxFailures',
    hint: 'options_general_maxFailures_desc',
    min: 1,
    max: 10,
  },
  {
    key: 'planningInterval',
    label: 'options_general_planningInterval',
    hint: 'options_general_planningInterval_desc',
    min: 1,
    max: 20,
  },
  {
    key: 'minWaitPageLoad',
    label: 'options_general_minWaitPageLoad',
    hint: 'options_general_minWaitPageLoad_desc',
    min: 250,
    max: 5000,
    step: 50,
  },
];

/** The browser agent's limits: steps, actions, retries, planning, page waits, vision and replay. */
export function AgentLimitsSection() {
  const settings = useStoreSettings(generalSettingsStore);
  if (!settings) return null;
  const update = (changes: Partial<GeneralSettingsConfig>) => void generalSettingsStore.updateSettings(changes);
  return (
    <>
      {LIMITS.map(limit => (
        <Row key={limit.key} title={t(limit.label)} hint={t(limit.hint)} htmlFor={`settings-${limit.key}`}>
          <input
            id={`settings-${limit.key}`}
            type="number"
            min={limit.min}
            max={limit.max}
            step={limit.step}
            value={settings[limit.key]}
            onChange={event => {
              const value = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(value)) update({ [limit.key]: value });
            }}
            className={NUMBER}
          />
        </Row>
      ))}
      <Row title={t('options_general_enableVision')} hint={t('options_general_enableVision_desc')}>
        <Switch
          label={t('options_general_enableVision')}
          checked={settings.useVision}
          onChange={value => update({ useVision: value })}
        />
      </Row>
      <Row title={t('options_general_replayHistoricalTasks')} hint={t('options_general_replayHistoricalTasks_desc')}>
        <Switch
          label={t('options_general_replayHistoricalTasks')}
          checked={settings.replayHistoricalTasks}
          onChange={value => update({ replayHistoricalTasks: value })}
        />
      </Row>
    </>
  );
}
