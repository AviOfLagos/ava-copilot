import { useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import { parseSkill, skillId, skillStore } from '@extension/storage';
import type { ParsedSkill } from '@extension/storage';
import { buttonClasses } from '../components/ui/button';
import SkillReviewCard from './SkillReviewCard';

interface TeachCardProps {
  // Resolves with the drafted skill as Markdown
  onDraft: () => Promise<string>;
  // The offer was answered: saved or dismissed; it is not shown again for this chat
  onDone: (saved: boolean) => void;
  isDarkMode?: boolean;
}

/**
 * Offered after a task that worked: "Save how I did this as a skill?". The drafted skill opens in the same review
 * card as an installed one, with its Markdown to edit; "Turn on" saves it.
 */
export default function TeachCard({ onDraft, onDone }: TeachCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The draft as the card reads it; an edit that does not parse keeps the last good reading and says why
  const parsed = useMemo((): { skill: ParsedSkill | null; problem: string | null } => {
    if (draft === null) return { skill: null, problem: null };
    try {
      return { skill: parseSkill(draft), problem: null };
    } catch (reason) {
      return { skill: null, problem: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [draft]);

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

  if (draft !== null) {
    const skill = parsed.skill;
    return (
      <div className="mt-2">
        <SkillReviewCard
          skill={{
            id: skill ? skillId(skill.name) : '…',
            description: skill?.description ?? '',
            urls: skill?.urls ?? [],
            keywords: skill?.keywords ?? [],
            body: skill?.body ?? draft,
            external: false,
          }}
          error={error ?? parsed.problem}
          onTurnOn={() => void save()}
          onDiscard={() => onDone(false)}
          editor={
            <div>
              <label htmlFor="skill-draft" className="label-mono mb-1 block">
                {t('skills_teach_review')}
              </label>
              <textarea
                id="skill-draft"
                value={draft}
                onChange={event => setDraft(event.target.value)}
                rows={12}
                className="text-foreground focus:border-primary/50 w-full rounded-xl border bg-black/20 p-2.5 font-mono text-[11.5px] leading-relaxed outline-none"
              />
            </div>
          }
        />
      </div>
    );
  }

  return (
    <section aria-label={t('skills_teach_title')} className={`${box} mt-2`}>
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
      {error && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
