import { useState } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { t } from '@extension/i18n';
import { CORE_FIELD_MAX, effectiveCore } from '@extension/storage';
import type { CoreIdentity } from '@extension/storage';
import { cn } from '@extension/ui';
import { useAssistantName } from '../hooks/useAssistant';
import type { PanelApi } from '../registry';
import { BUTTON, HINT, INPUT } from './AboutYouSettings';
import { useCoreIdentity } from './useIdentity';

type Field = Exclude<keyof CoreIdentity, 'updatedAt'>;
type MessageKey = Parameters<typeof t>[0];

const FIELDS: { key: Field; label: MessageKey }[] = [
  { key: 'character', label: 'ava_core_character' },
  { key: 'values', label: 'ava_core_values' },
  { key: 'purpose', label: 'ava_core_purpose' },
];

/**
 * "Ava's core" at the top of Settings › Personalities: who she is whatever the personality (character, values,
 * purpose and ambitions). Edited here, reset to the default in one click; the safety rules always stay above it.
 */
export default function CoreIdentitySection({ api }: { api: PanelApi }) {
  const name = useAssistantName();
  const stored = useCoreIdentity();
  const core = effectiveCore(stored);
  const edited = FIELDS.some(field => stored[field.key].trim());
  const [draft, setDraft] = useState<typeof core | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft) return;
    try {
      await api.request({ type: 'identity_core_save', ...draft });
      setDraft(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" aria-label={t('ava_core_title', [name])} role="group">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[13px] font-medium">{t('ava_core_title', [name])}</div>
        <span className="label-mono text-muted-foreground">
          {edited ? t('ava_core_edited') : t('ava_core_default')}
        </span>
      </div>
      <p className={HINT}>{t('ava_core_hint', [name])}</p>
      {draft ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}>
          {FIELDS.map(field => (
            <label key={field.key} className="flex flex-col gap-1 text-[12.5px]">
              {t(field.label)}
              <textarea
                className={cn(INPUT, 'min-h-[84px] resize-y leading-snug')}
                value={draft[field.key]}
                maxLength={CORE_FIELD_MAX}
                onChange={event => setDraft({ ...draft, [field.key]: event.target.value })}
                onKeyDown={event => event.key === 'Escape' && setDraft(null)}
              />
            </label>
          ))}
          {error && (
            <p role="alert" className="text-destructive text-[12px]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={() => setDraft(null)}>
              {t('ava_cancel')}
            </button>
            <button type="submit" className={cn(BUTTON, 'border-primary/50 bg-primary/15')}>
              {t('ava_save')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="flex flex-col gap-1.5 text-[12px]">
            {FIELDS.map(field => (
              <div key={field.key}>
                <dt className="label-mono text-muted-foreground">{t(field.label)}</dt>
                <dd className="line-clamp-3 leading-snug">{core[field.key]}</dd>
              </div>
            ))}
          </dl>
          <p className={HINT}>{t('ava_core_nameNote')}</p>
          <div className="flex gap-2">
            <button type="button" className={BUTTON} onClick={() => setDraft(core)}>
              <Pencil className="size-3.5" aria-hidden />
              {t('ava_core_edit')}
            </button>
            {edited && (
              <button
                type="button"
                className={BUTTON}
                onClick={() => void api.request({ type: 'identity_core_reset' })}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('ava_core_reset')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
