import { useState } from 'react';
import { t } from '@extension/i18n';
import { skillStore } from '@extension/storage';
import { buttonClasses } from '../components/ui/button';

interface TeachCardProps {
  // Resolves with the drafted skill as Markdown
  onDraft: () => Promise<string>;
  // The offer was answered: saved or dismissed; it is not shown again for this chat
  onDone: (saved: boolean) => void;
  isDarkMode?: boolean;
}

/**
 * Offered after a task that worked: "Save as skill?". The drafted skill is shown as Markdown to
 * read and edit before it is saved.
 */
export default function TeachCard({ onDraft, onDone }: TeachCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const box = 'glass rounded-2xl p-3 text-[13px]';
  const quiet = buttonClasses('glass', 'sm');
  const primary = buttonClasses('default', 'sm');

  const write = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await onDraft());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (draft === null) return;
    setError(null);
    try {
      const skill = await skillStore.save(draft, 'taught');
      setSaved(skill.id);
      onDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (saved) {
    return (
      <p role="status" className={`${box} mt-2`}>
        {t('skills_teach_saved', [saved])}
      </p>
    );
  }

  return (
    <section aria-label={t('skills_teach_title')} className={`${box} mt-2`}>
      {draft === null ? (
        <div className="flex items-center justify-between gap-2">
          <span>{busy ? t('skills_teach_writing') : t('skills_teach_offer')}</span>
          <span className="flex shrink-0 gap-1">
            <button type="button" className={quiet} onClick={() => onDone(false)} disabled={busy}>
              {t('skills_teach_dismiss')}
            </button>
            <button type="button" className={primary} onClick={() => void write()} disabled={busy}>
              {t('skills_teach_button')}
            </button>
          </span>
        </div>
      ) : (
        <>
          <label htmlFor="skill-draft" className="mb-1 block text-xs font-semibold">
            {t('skills_teach_review')}
          </label>
          <textarea
            id="skill-draft"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            rows={12}
            className="text-foreground focus:border-primary/50 w-full rounded-xl border bg-black/20 p-2.5 font-mono text-[11.5px] leading-relaxed outline-none"
          />
          <div className="mt-1 flex justify-end gap-1">
            <button type="button" className={quiet} onClick={() => onDone(false)}>
              {t('skills_teach_cancel')}
            </button>
            <button type="button" className={primary} onClick={() => void save()}>
              {t('skills_teach_save')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
