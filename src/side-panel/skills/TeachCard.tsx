import { useState } from 'react';
import { t } from '@extension/i18n';
import { skillStore } from '@extension/storage';

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
export default function TeachCard({ onDraft, onDone, isDarkMode = false }: TeachCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const box = `rounded-lg border p-2 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-200' : 'border-sky-100 bg-white/90 text-gray-800'}`;
  const quiet = `rounded-md border px-2 py-1 text-xs font-medium ${isDarkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-gray-300 bg-white hover:bg-gray-100'}`;
  const primary = 'rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50';

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
            className={`w-full rounded border p-2 font-mono text-xs ${isDarkMode ? 'border-slate-600 bg-slate-900' : 'border-gray-300 bg-white'}`}
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
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
