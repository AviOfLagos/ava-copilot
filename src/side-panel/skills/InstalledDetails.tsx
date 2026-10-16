import { useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import { lineDiff, revealInvisible, skillFullText, skillRedFlags, skillStore } from '@extension/storage';
import type { DiffLine, SkillCandidate, SkillRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import type { PanelApi } from '../registry';
import { buttonClasses } from '../components/ui/button';
import { FLAG_TEXT, appliesTo } from './SkillReviewCard';

// Lines of context kept around each change, and the most lines shown
const CONTEXT = 2;
const MAX_LINES = 400;

/** The changed lines of a diff with a little context; runs of unchanged lines become "…". */
export function compactDiff(lines: DiffLine[]): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.op === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out.slice(0, MAX_LINES);
}

/**
 * An installed skill's details: where it came from, and "Check for update", which fetches the link again and shows
 * what changed. Nothing changes until "Use this version".
 */
export default function InstalledDetails({ api, skill }: { api: PanelApi; skill: SkillRecord }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [candidate, setCandidate] = useState<SkillCandidate | null>(null);
  const fromLink = /^https?:/i.test(skill.origin?.url ?? '');

  const diff = useMemo(
    () => (candidate ? compactDiff(lineDiff(skillFullText(skill), skillFullText(candidate))) : []),
    [candidate, skill],
  );
  const flags = useMemo(() => (candidate ? skillRedFlags(candidate, candidate.origin.url) : []), [candidate]);

  const check = async () => {
    setBusy(true);
    setError(null);
    setUpToDate(false);
    setCandidate(null);
    try {
      const reply = await api.request<{ upToDate: boolean; candidate: SkillCandidate }>(
        { type: 'skills_check_update', id: skill.id },
        90_000,
      );
      if (reply.upToDate) setUpToDate(true);
      else setCandidate(reply.candidate);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!candidate) return;
    try {
      await skillStore.applyUpdate(skill.id, candidate);
      setCandidate(null);
      setUpToDate(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 text-[12px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t('skills_review_from')}</dt>
        <dd className="min-w-0 break-all font-mono text-[11px]">{skill.origin?.url}</dd>
        <dt className="text-muted-foreground">{t('skills_review_sites')}</dt>
        <dd className="min-w-0 break-words">{appliesTo(skill)}</dd>
      </dl>
      {fromLink && (
        <div className="flex items-center gap-2">
          <button type="button" className={buttonClasses('glass', 'sm')} onClick={() => void check()} disabled={busy}>
            {busy ? t('skills_update_checking') : t('skills_update_check')}
          </button>
          {upToDate && (
            <span role="status" className="text-muted-foreground">
              {t('skills_update_upToDate')}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {candidate && (
        <div aria-label={t('skills_update_changes')} className="flex flex-col gap-2">
          <p className="label-mono">{t('skills_update_changes')}</p>
          {flags.length > 0 && (
            <p role="note" className="bg-destructive/10 rounded-xl px-2.5 py-1.5">
              {t('skills_review_flagsTitle')}: {flags.map(flag => t(FLAG_TEXT[flag])).join(' ')}
            </p>
          )}
          <pre className="max-h-72 overflow-auto rounded-xl border bg-black/20 p-2 font-mono text-[11px] leading-relaxed">
            {diff.map((line, i) =>
              line === null ? (
                <div key={i} className="text-muted-foreground">
                  …
                </div>
              ) : (
                <div
                  key={i}
                  data-op={line.op}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    line.op === 'add' && 'bg-primary/15',
                    line.op === 'del' && 'bg-destructive/15 line-through decoration-1',
                  )}>
                  {line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  '}
                  {revealInvisible(line.text)}
                </div>
              ),
            )}
          </pre>
          <div className="flex justify-end gap-1.5">
            <button type="button" className={buttonClasses('glass', 'sm')} onClick={() => setCandidate(null)}>
              {t('skills_update_keep')}
            </button>
            <button type="button" className={buttonClasses('hold', 'sm')} onClick={() => void apply()}>
              {t('skills_update_apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
