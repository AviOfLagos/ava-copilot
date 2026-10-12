import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { t } from '@extension/i18n';
import { skillStore } from '@extension/storage';
import type { SkillRecord } from '@extension/storage';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';

/**
 * Skills as their own place (reached from the profile menu): the on/off list that used to live in
 * Settings, plus a reminder that the copilot offers to write one itself after a task goes well
 * (`skills/TeachCard.tsx`, shown under a finished chat) — there is nothing to click here for that.
 * It needs nothing from `PanelApi`, so the registry's `{ api }` prop is left out below.
 */
export default function SkillsPlace() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);

  useEffect(() => {
    void skillStore.all().then(setSkills);
    return skillStore.subscribe(() => void skillStore.all().then(setSkills));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-3">
      <section
        aria-label={t('shell_skills_teachHint_title')}
        className="glass flex items-start gap-2.5 rounded-2xl p-3.5">
        <Sparkles className="text-primary mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <p className="text-[12.5px] leading-relaxed">{t('shell_skills_teachHint')}</p>
      </section>

      <section aria-label={t('options_skills_header')}>
        <h3 className="label-mono mb-1.5 px-1">{t('options_skills_header')}</h3>
        <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">
          {skills.length === 0 && (
            <p className="text-muted-foreground px-3 py-2.5 text-[12.5px]">{t('shell_skills_empty')}</p>
          )}
          {skills.map(skill => (
            <div key={skill.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span>/{skill.id}</span>
                  {skill.source !== 'builtin' && (
                    <Badge variant="outline" className="normal-case">
                      {skill.source}
                    </Badge>
                  )}
                </div>
                {skill.description && (
                  <div className="text-muted-foreground mt-0.5 text-[11.5px]">{skill.description}</div>
                )}
              </div>
              <Switch
                label={`/${skill.id}`}
                checked={skill.enabled}
                onChange={value => void skillStore.setEnabled(skill.id, value)}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
