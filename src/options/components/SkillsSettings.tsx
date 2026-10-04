import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@extension/i18n';
import { skillStore, skillToMarkdown } from '@extension/storage';
import type { SkillRecord } from '@extension/storage';

interface SkillsSettingsProps {
  isDarkMode?: boolean;
}

const NEW_SKILL = skillToMarkdown({
  name: 'my-site',
  description: 'When this skill applies',
  urls: ['app.example.com/*'],
  keywords: ['example'],
  body: '- A tip the agent should know on this site.',
});

const SOURCE_LABELS = {
  builtin: 'options_skills_source_builtin',
  imported: 'options_skills_source_imported',
  taught: 'options_skills_source_taught',
  written: 'options_skills_source_written',
} as const;

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Skills: Markdown playbooks the agent loads when the page or task matches. Import, write, edit,
 * turn off, export and delete them here.
 */
export function SkillsSettings({ isDarkMode = false }: SkillsSettingsProps) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  // The skill being edited, by id, or 'new'; with its Markdown
  const [editing, setEditing] = useState<{ id: string; markdown: string } | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => void skillStore.all().then(setSkills), []);
  useEffect(() => {
    load();
    return skillStore.subscribe(load);
  }, [load]);

  const report = (text: string, error = false) => setStatus({ text, error });

  const importFiles = async (files: FileList) => {
    const names: string[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        names.push((await skillStore.save(await file.text(), 'imported', file.name)).id);
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    load();
    if (failures.length) report(failures.join('\n'), true);
    else report(t('options_skills_imported', [names.map(name => `/${name}`).join(', ')]));
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const previous = skills.find(skill => skill.id === editing.id);
      const source = previous && previous.source !== 'builtin' ? previous.source : 'written';
      const saved = await skillStore.save(editing.markdown, source);
      // A renamed skill replaces the old one
      if (previous && previous.source !== 'builtin' && previous.id !== saved.id) await skillStore.remove(previous.id);
      setEditing(null);
      load();
      report(t('options_skills_saved', [saved.id]));
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    }
  };

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const button = `rounded-md border px-3 py-1.5 text-sm font-medium ${isDarkMode ? 'border-slate-600 text-gray-200 hover:bg-slate-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`;
  const small = `rounded border px-2 py-0.5 text-xs ${isDarkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-gray-300 bg-white hover:bg-gray-50'}`;

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-1 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          {t('options_skills_header')}
        </h2>
        <p className={`mb-4 text-sm ${muted}`}>{t('options_skills_desc')}</p>

        <div className="mb-4 flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => fileRef.current?.click()}>
            {t('options_skills_import')}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            aria-label={t('options_skills_import')}
            onChange={event => {
              const files = event.target.files;
              if (files?.length) void importFiles(files).finally(() => (event.target.value = ''));
            }}
          />
          <button type="button" className={button} onClick={() => setEditing({ id: 'new', markdown: NEW_SKILL })}>
            {t('options_skills_new')}
          </button>
        </div>

        {status && (
          <p
            role={status.error ? 'alert' : 'status'}
            className={`mb-3 whitespace-pre-wrap text-sm ${status.error ? 'text-red-600' : isDarkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>
            {status.text}
          </p>
        )}

        {editing && (
          <div className="mb-4">
            <label htmlFor="skill-editor" className="mb-1 block text-sm font-medium">
              {editing.id === 'new' ? t('options_skills_new') : t('options_skills_editing', [editing.id])}
            </label>
            <textarea
              id="skill-editor"
              rows={16}
              value={editing.markdown}
              onChange={event => setEditing({ ...editing, markdown: event.target.value })}
              className={`w-full rounded-md border p-2 font-mono text-sm ${isDarkMode ? 'border-slate-600 bg-slate-900 text-gray-200' : 'border-gray-300 bg-white'}`}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                onClick={() => void saveEdit()}>
                {t('options_skills_save')}
              </button>
              <button type="button" className={button} onClick={() => setEditing(null)}>
                {t('options_skills_cancel')}
              </button>
            </div>
          </div>
        )}

        <ul className="space-y-2" aria-label={t('options_skills_header')}>
          {skills.map(skill => (
            <li
              key={skill.id}
              className={`rounded-md border p-3 ${isDarkMode ? 'border-slate-700' : 'border-gray-200'} ${skill.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">
                    /{skill.id} <span className={`text-xs font-normal ${muted}`}>{t(SOURCE_LABELS[skill.source])}</span>
                  </div>
                  {skill.description && <p className="text-sm">{skill.description}</p>}
                  <p className={`break-words text-xs ${muted}`}>
                    {[
                      skill.urls.length ? t('options_skills_urls', [skill.urls.join(', ')]) : '',
                      skill.keywords.length ? t('options_skills_keywords', [skill.keywords.join(', ')]) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || t('options_skills_slashOnly')}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    onChange={event => void skillStore.setEnabled(skill.id, event.target.checked).then(load)}
                  />
                  {t('options_skills_on')}
                </label>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className={small}
                  onClick={() => setEditing({ id: skill.id, markdown: skillToMarkdown(skill) })}>
                  {t('options_skills_edit')}
                </button>
                <button
                  type="button"
                  className={small}
                  onClick={() => download(`${skill.id}.md`, skillToMarkdown(skill))}>
                  {t('options_skills_export')}
                </button>
                {skill.source !== 'builtin' && (
                  <button
                    type="button"
                    className={`${small} text-red-600`}
                    onClick={() => {
                      if (window.confirm(t('options_skills_deleteConfirm', [skill.id]))) {
                        void skillStore.remove(skill.id).then(load);
                      }
                    }}>
                    {t('options_skills_delete')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
