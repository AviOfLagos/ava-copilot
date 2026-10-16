import { useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import { t } from '@extension/i18n';
import { revealInvisible, skillFullText, skillRedFlags, skillSize } from '@extension/storage';
import type { DroppedSkillFile, SkillOrigin, SkillRedFlag, SkillReference } from '@extension/storage';
import { Badge } from '../components/ui/badge';
import { buttonClasses } from '../components/ui/button';

type MessageKey = Parameters<typeof t>[0];

export const FLAG_TEXT: Record<SkillRedFlag, MessageKey> = {
  actions: 'skills_flag_actions',
  credentials: 'skills_flag_credentials',
  outside_urls: 'skills_flag_outside_urls',
  hidden: 'skills_flag_hidden',
  override: 'skills_flag_override',
  long: 'skills_flag_long',
};

const DROPPED_TEXT: Record<DroppedSkillFile['reason'], MessageKey> = {
  code: 'skills_review_dropped_code',
  other: 'skills_review_dropped_other',
  too_long: 'skills_review_dropped_too_long',
};

/** What the card shows: a skill as installed, or a draft being written. */
export interface ReviewedSkill {
  id: string;
  description: string;
  urls: string[];
  keywords: string[];
  body: string;
  references?: SkillReference[];
  dropped?: DroppedSkillFile[];
  origin?: Pick<SkillOrigin, 'url' | 'kind'>;
  // Someone else wrote it: the card says so and the user must read it first
  external: boolean;
}

interface SkillReviewCardProps {
  skill: ReviewedSkill;
  // "Turn on": the only way an installed skill starts loading
  onTurnOn: () => void;
  onDiscard: () => void;
  onLater?: () => void;
  busy?: boolean;
  error?: string | null;
  // In place of the full text, e.g. the draft's editor
  editor?: React.ReactNode;
  extraActions?: React.ReactNode;
}

/** Where it applies, in a few words: its sites, else the words that call it in, else only /name. */
export function appliesTo(skill: Pick<ReviewedSkill, 'id' | 'urls' | 'keywords'>): string {
  if (skill.urls.length) return skill.urls.join(', ');
  if (skill.keywords.length) return t('skills_review_sitesAny', [skill.keywords.join(', ')]);
  return t('skills_review_slashOnly', [skill.id]);
}

/**
 * The review card: where a skill came from, what it applies to, its size, warnings about instruction-like text,
 * the files left out, and the whole text. Nothing loads until "Turn on".
 */
export default function SkillReviewCard({
  skill,
  onTurnOn,
  onDiscard,
  onLater,
  busy,
  error,
  editor,
  extraActions,
}: SkillReviewCardProps) {
  const flags = useMemo(() => skillRedFlags(skill, skill.origin?.url), [skill]);
  const text = useMemo(() => revealInvisible(skillFullText(skill)), [skill]);
  const files = 1 + (skill.references?.length ?? 0);

  return (
    <section
      aria-label={t('skills_review_title')}
      data-skill-review={skill.id}
      className="glass flex flex-col gap-2.5 rounded-2xl p-3 text-[12.5px]">
      <header className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">/{skill.id}</span>
        <Badge variant="hold">{t('skills_review_pending')}</Badge>
      </header>
      {skill.description && <p className="text-muted-foreground leading-relaxed">{skill.description}</p>}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {skill.origin && (
          <>
            <dt className="text-muted-foreground">{t('skills_review_from')}</dt>
            <dd className="min-w-0 break-all font-mono text-[11px]">{skill.origin.url}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('skills_review_sites')}</dt>
        <dd className="min-w-0 break-words">{appliesTo(skill)}</dd>
      </dl>
      <p className="text-muted-foreground text-[12px]">
        {t('skills_review_size', [String(skillSize(skill)), String(files)])}
      </p>

      {skill.external && (
        <p className="border-border/60 rounded-xl border px-2.5 py-2 leading-relaxed">{t('skills_review_untrusted')}</p>
      )}

      {flags.length > 0 && (
        <div
          role="note"
          aria-label={t('skills_review_flagsTitle')}
          className="bg-destructive/10 rounded-xl px-2.5 py-2">
          <p className="mb-1 flex items-center gap-1.5 font-semibold">
            <ShieldAlert className="size-3.5" strokeWidth={1.75} />
            {t('skills_review_flagsTitle')}
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {flags.map(flag => (
              <li key={flag} data-flag={flag}>
                {t(FLAG_TEXT[flag])}
              </li>
            ))}
          </ul>
        </div>
      )}

      {skill.dropped && skill.dropped.length > 0 && (
        <div aria-label={t('skills_review_droppedTitle')}>
          <p className="label-mono mb-1">{t('skills_review_droppedTitle')}</p>
          <ul className="space-y-0.5 text-[11.5px]">
            {skill.dropped.map(file => (
              <li key={file.path} className="break-all">
                <span className="font-mono">{file.path}</span>{' '}
                <span className="text-muted-foreground">— {t(DROPPED_TEXT[file.reason])}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editor ?? (
        <div>
          <p className="label-mono mb-1">{t('skills_review_text')}</p>
          <pre
            aria-label={t('skills_review_text')}
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-black/20 p-2.5 font-mono text-[11.5px] leading-relaxed">
            {text}
          </pre>
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {extraActions}
        <button type="button" className={buttonClasses('ghost', 'sm')} onClick={onDiscard} disabled={busy}>
          {t('skills_review_discard')}
        </button>
        {onLater && (
          <button type="button" className={buttonClasses('glass', 'sm')} onClick={onLater} disabled={busy}>
            {t('skills_review_later')}
          </button>
        )}
        <button type="button" className={buttonClasses('hold', 'sm')} onClick={onTurnOn} disabled={busy}>
          {t('skills_review_turnOn')}
        </button>
      </div>
    </section>
  );
}
