import { useEffect, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { t } from '@extension/i18n';
import { awaitingReview, skillStore } from '@extension/storage';
import type { SkillRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import type { PanelApi } from '../registry';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { buttonClasses } from '../components/ui/button';
import InstallSection from './InstallSection';
import InstalledDetails from './InstalledDetails';
import SkillReviewCard from './SkillReviewCard';

/** An installed skill as the review card shows it. */
export function reviewedFrom(skill: SkillRecord) {
  return { ...skill, external: skill.trust === 'external' };
}

/**
 * Skills as their own place (reached from the profile menu): install one from a link or a file, find one in the
 * starter collections, review installed ones before they load, and the on/off list. The copilot also offers to
 * write a skill itself after a task goes well (`skills/TeachCard.tsx`, under a finished chat).
 */
export default function SkillsPlace({ api }: { api: PanelApi }) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  // Review cards put off with "Later": they wait in the list with a Review button
  const [later, setLater] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [turnedOn, setTurnedOn] = useState<string | null>(null);

  useEffect(() => {
    void skillStore.all().then(setSkills);
    return skillStore.subscribe(() => void skillStore.all().then(setSkills));
  }, []);

  const pending = skills.filter(skill => awaitingReview(skill) && !later.has(skill.id));

  const act = async (id: string, work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError({ id, message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  };

  const showReview = (id: string) => {
    setTurnedOn(null);
    setLater(current => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    requestAnimationFrame(() =>
      document.querySelector(`[data-skill-review="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-3">
      <section
        aria-label={t('shell_skills_teachHint_title')}
        className="glass flex items-start gap-2.5 rounded-2xl p-3.5">
        <Sparkles className="text-primary mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <p className="text-[12.5px] leading-relaxed">{t('shell_skills_teachHint')}</p>
      </section>

      {pending.map(skill => (
        <SkillReviewCard
          key={`${skill.id}:${skill.sha256}`}
          skill={reviewedFrom(skill)}
          busy={busy}
          error={error?.id === skill.id ? error.message : null}
          onTurnOn={() =>
            void act(skill.id, async () => {
              await skillStore.approve(skill.id, skill.sha256 ?? '');
              setTurnedOn(skill.id);
            })
          }
          onDiscard={() => void act(skill.id, () => skillStore.remove(skill.id))}
          onLater={() => setLater(current => new Set(current).add(skill.id))}
        />
      ))}
      {turnedOn && (
        <p role="status" className="glass rounded-2xl p-3 text-[12.5px]">
          {t('skills_review_on', [turnedOn])}
        </p>
      )}

      <InstallSection api={api} onInstalled={showReview} />

      <section aria-label={t('options_skills_header')}>
        <h3 className="label-mono mb-1.5 px-1">{t('options_skills_header')}</h3>
        <ul className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">
          {skills.length === 0 && (
            <li className="text-muted-foreground px-3 py-2.5 text-[12.5px]">{t('shell_skills_empty')}</li>
          )}
          {skills.map(skill => {
            const external = skill.trust === 'external';
            const waiting = awaitingReview(skill);
            const expanded = open === skill.id;
            return (
              <li key={skill.id} data-skill={skill.id}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <span className="break-all">/{skill.id}</span>
                      {external ? (
                        <Badge variant="outline" className="normal-case">
                          {t('skills_badge_installed')}
                        </Badge>
                      ) : (
                        skill.source !== 'builtin' && (
                          <Badge variant="outline" className="normal-case">
                            {skill.source}
                          </Badge>
                        )
                      )}
                    </div>
                    {skill.description && (
                      <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11.5px]">{skill.description}</div>
                    )}
                  </div>
                  {external && !waiting && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={t('skills_list_details', [skill.id])}
                      className={buttonClasses('ghost', 'icon-sm')}
                      onClick={() => setOpen(expanded ? null : skill.id)}>
                      <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
                    </button>
                  )}
                  {waiting ? (
                    <button
                      type="button"
                      className={buttonClasses('hold', 'sm')}
                      aria-label={`${t('skills_list_review')} /${skill.id}`}
                      onClick={() => showReview(skill.id)}>
                      {t('skills_list_review')}
                    </button>
                  ) : (
                    <Switch
                      label={`/${skill.id}`}
                      checked={skill.enabled}
                      onChange={value =>
                        void skillStore
                          .setEnabled(skill.id, value)
                          .catch(reason => setError({ id: skill.id, message: String(reason) }))
                      }
                    />
                  )}
                </div>
                {expanded && <InstalledDetails api={api} skill={skill} />}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
