import { useEffect, useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  allPersonalities,
  duplicatePersonality,
  KITTEN_VOICES,
  KOKORO_VOICES,
  PERSONALITY_INSTRUCTIONS_MAX,
  personalityStore,
} from '@extension/storage';
import type { Personality, PersonalityProblem } from '@extension/storage';
import { cn } from '@extension/ui';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { personalityDescription, personalityName, usePersonalities } from './usePersonalities';

type MessageKey = Parameters<typeof t>[0];

const INPUT = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';
const BUTTON =
  'glass inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';
const ICON_BUTTON =
  'flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';
const HINT = 'text-muted-foreground text-[11.5px]';
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

const PROBLEMS: Record<PersonalityProblem, MessageKey> = {
  nameEmpty: 'persona_problem_nameEmpty',
  nameTooLong: 'persona_problem_nameTooLong',
  descriptionTooLong: 'persona_problem_descriptionTooLong',
  iconTooLong: 'persona_problem_iconTooLong',
  instructionsEmpty: 'persona_problem_instructionsEmpty',
  instructionsTooLong: 'persona_problem_instructionsTooLong',
  rate: 'persona_problem_rate',
  builtIn: 'persona_problem_builtIn',
  tooMany: 'persona_problem_tooMany',
};

const blank = (): Personality => ({
  id: '',
  name: '',
  description: '',
  icon: '💬',
  instructions: '',
  voice: '',
  rate: 0,
});

/** The voices a personality may pick: the system's, then the local engines' ids. */
function useVoices(): string[] {
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    try {
      chrome.tts.getVoices(found =>
        setVoices(found.map(voice => voice.voiceName).filter((name): name is string => !!name)),
      );
    } catch {
      setVoices([]);
    }
  }, []);
  return voices;
}

function Editor({ initial, onDone }: { initial: Personality; onDone: () => void }) {
  const [draft, setDraft] = useState<Personality>(initial);
  const [problems, setProblems] = useState<PersonalityProblem[]>([]);
  const voices = useVoices();
  const set = (changes: Partial<Personality>) => setDraft(current => ({ ...current, ...changes }));
  const save = async () => {
    const result = await personalityStore.save(draft);
    if (result.ok) onDone();
    else setProblems(result.problems);
  };
  const length = draft.instructions.length;

  return (
    <form
      aria-label={initial.id ? t('persona_edit_title') : t('persona_new_title')}
      className="divide-border/60 divide-y"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}>
      <div className="flex gap-2 px-3 py-2.5">
        <div className="flex w-16 flex-col gap-1.5">
          <label htmlFor="persona-icon" className="text-[13px]">
            {t('persona_field_icon')}
          </label>
          <input
            id="persona-icon"
            className={cn(INPUT, 'text-center')}
            value={draft.icon}
            maxLength={8}
            onChange={event => set({ icon: event.target.value })}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="persona-name" className="text-[13px]">
            {t('persona_field_name')}
          </label>
          <input
            id="persona-name"
            className={INPUT}
            value={draft.name}
            maxLength={40}
            onChange={event => set({ name: event.target.value })}
          />
        </div>
      </div>
      <div className={ROW}>
        <label htmlFor="persona-description" className="text-[13px]">
          {t('persona_field_description')}
        </label>
        <input
          id="persona-description"
          className={INPUT}
          value={draft.description}
          maxLength={160}
          onChange={event => set({ description: event.target.value })}
        />
      </div>
      <div className={ROW}>
        <label htmlFor="persona-instructions" className="text-[13px]">
          {t('persona_field_instructions')}
        </label>
        <textarea
          id="persona-instructions"
          className={cn(INPUT, 'min-h-[140px] resize-y leading-snug')}
          value={draft.instructions}
          placeholder={t('persona_field_instructions_placeholder')}
          onChange={event => set({ instructions: event.target.value })}
        />
        <div className={cn(HINT, 'flex justify-between gap-2')}>
          <span>{t('persona_field_instructions_hint')}</span>
          <span className={cn('shrink-0 font-mono', length > PERSONALITY_INSTRUCTIONS_MAX && 'text-destructive')}>
            {length}/{PERSONALITY_INSTRUCTIONS_MAX}
          </span>
        </div>
      </div>
      <div className="flex gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="persona-voice" className="text-[13px]">
            {t('persona_field_voice')}
          </label>
          <select
            id="persona-voice"
            className={INPUT}
            value={draft.voice}
            onChange={event => set({ voice: event.target.value })}>
            <option value="">{t('persona_field_voice_settings')}</option>
            {draft.voice && ![...voices, ...KITTEN_VOICES, ...KOKORO_VOICES].includes(draft.voice) && (
              <option value={draft.voice}>{draft.voice}</option>
            )}
            {voices.length > 0 && (
              <optgroup label={t('persona_field_voice_system')}>
                {voices.map(voice => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Kitten">
              {KITTEN_VOICES.map(voice => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </optgroup>
            <optgroup label="Kokoro">
              {KOKORO_VOICES.map(voice => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="flex w-28 flex-col gap-1.5">
          <label htmlFor="persona-rate" className="text-[13px]">
            {t('persona_field_rate')}
          </label>
          <select
            id="persona-rate"
            className={INPUT}
            value={String(draft.rate)}
            onChange={event => set({ rate: Number(event.target.value) })}>
            <option value="0">{t('persona_field_voice_settings')}</option>
            {RATES.map(rate => (
              <option key={rate} value={String(rate)}>
                {rate}×
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className={HINT}>{t('persona_rules_hint')}</p>
        {problems.length > 0 && (
          <ul role="alert" className="text-destructive text-[12px]">
            {problems.map(problem => (
              <li key={problem}>{t(PROBLEMS[problem])}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onDone}>
            {t('persona_cancel')}
          </button>
          <button type="submit" className={cn(BUTTON, 'border-primary/50 bg-primary/15')}>
            {t('persona_save')}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Settings › Personalities: pick the one in force, make your own (or copy a built-in to change it), and give a
 * workspace its own default.
 */
export default function PersonalitiesSettings() {
  const state = usePersonalities();
  const workspaces = useWorkspaces();
  const [editing, setEditing] = useState<Personality | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const all = allPersonalities(state);

  if (editing) return <Editor initial={editing} onDone={() => setEditing(null)} />;

  return (
    <>
      <p className={cn(HINT, 'px-3 py-2.5')}>{t('persona_settings_hint')}</p>
      <ul aria-label={t('persona_list_label')} className="divide-border/60 divide-y">
        {all.map(personality => {
          const active = personality.id === state.activeId;
          const name = personalityName(personality);
          return (
            <li key={personality.id} className="flex items-start gap-2.5 px-3 py-2.5">
              <span aria-hidden="true" className="mt-0.5 w-5 shrink-0 text-center text-[16px]">
                {personality.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span className="truncate">{name}</span>
                  {personality.builtIn && (
                    <span className="label-mono text-muted-foreground shrink-0">{t('persona_builtIn')}</span>
                  )}
                </div>
                <div className="text-muted-foreground line-clamp-2 text-[11.5px]">
                  {personalityDescription(personality)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={t('persona_use', [name])}
                  className={cn(
                    'h-7 rounded-full border px-2 text-[11.5px] transition-colors',
                    active
                      ? 'border-primary/50 bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                  onClick={() => void personalityStore.setActive(personality.id, null)}>
                  {active ? t('persona_active') : t('persona_useShort')}
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={t('persona_duplicate', [name])}
                  title={t('persona_duplicate', [name])}
                  onClick={() => setEditing(duplicatePersonality({ ...personality, name }, t('persona_copySuffix')))}>
                  <Copy className="size-3.5" />
                </button>
                {!personality.builtIn && (
                  <>
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      aria-label={t('persona_edit', [name])}
                      title={t('persona_edit', [name])}
                      onClick={() => setEditing(personality)}>
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className={cn(ICON_BUTTON, deleting === personality.id && 'text-destructive bg-destructive/10')}
                      aria-label={
                        deleting === personality.id ? t('persona_delete_confirm') : t('persona_delete', [name])
                      }
                      title={deleting === personality.id ? t('persona_delete_confirm') : t('persona_delete', [name])}
                      onBlur={() => setDeleting(null)}
                      onClick={() => {
                        if (deleting !== personality.id) return setDeleting(personality.id);
                        setDeleting(null);
                        void personalityStore.remove(personality.id);
                      }}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-2.5">
        <button type="button" className={BUTTON} onClick={() => setEditing(blank())}>
          <Plus className="size-3.5" />
          {t('persona_new')}
        </button>
      </div>
      {workspaces.length > 0 && (
        <div className={ROW}>
          <div className="text-[13px]">{t('persona_workspaces_title')}</div>
          <p className={HINT}>{t('persona_workspaces_hint')}</p>
          {workspaces.map(workspace => (
            <label key={workspace.id} className="flex items-center gap-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <select
                aria-label={t('persona_workspace_default', [workspace.name])}
                className={cn(INPUT, 'w-[55%]')}
                value={state.workspaceDefaults[workspace.id] ?? ''}
                onChange={event => void personalityStore.setWorkspaceDefault(workspace.id, event.target.value || null)}>
                <option value="">{t('persona_workspace_none')}</option>
                {all.map(personality => (
                  <option key={personality.id} value={personality.id}>
                    {personality.icon} {personalityName(personality)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </>
  );
}
