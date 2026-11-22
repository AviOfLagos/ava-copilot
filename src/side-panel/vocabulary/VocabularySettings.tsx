import { useEffect, useState } from 'react';
import { db, workspaceStore } from '@extension/storage';
import type { VocabEntry, Workspace } from '@extension/storage';
import { t } from '@extension/i18n';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { BUTTON, HINT, INPUT } from '../identity/AboutYouSettings';

const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';

const splitHeard = (value: string) =>
  value
    .split(/[,;\n]/)
    .map(part => part.trim())
    .filter(Boolean);

interface Draft {
  id?: string;
  write: string;
  heard: string;
  workspaceId: string | null;
}

/** The add and edit form: the right spelling, what it is heard as, and where it applies. */
function EntryForm({
  draft,
  workspaces,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  workspaces: Workspace[];
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(draft);
  const [busy, setBusy] = useState(false);
  const id = `vocab-${draft.id ?? 'new'}`;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault();
        if (!value.write.trim()) return;
        setBusy(true);
        void onSubmit(value)
          .then(() => !draft.id && setValue(draft))
          .finally(() => setBusy(false));
      }}>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-write`} className="text-[12.5px]">
          {t('vocab_write_label')}
        </label>
        <input
          id={`${id}-write`}
          className={INPUT}
          value={value.write}
          maxLength={60}
          placeholder="Ellum"
          onChange={event => setValue({ ...value, write: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-heard`} className="text-[12.5px]">
          {t('vocab_heard_label')}
        </label>
        <input
          id={`${id}-heard`}
          className={INPUT}
          value={value.heard}
          placeholder="Illum, Elum, L.M."
          onChange={event => setValue({ ...value, heard: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-where`} className="text-[12.5px]">
          {t('vocab_scope_label')}
        </label>
        <select
          id={`${id}-where`}
          className={INPUT}
          value={value.workspaceId ?? ''}
          onChange={event => setValue({ ...value, workspaceId: event.target.value || null })}>
          <option value="">{t('vocab_scope_all')}</option>
          {workspaces.map(workspace => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy || !value.write.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={BUTTON} onClick={onCancel}>
            {t('vocab_cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

/** Settings › Voice › Vocabulary: a list to add, edit and delete, with how often each entry changed a word. */
export default function VocabularySettings({ api }: { api: PanelApi }) {
  const entries = useLive<VocabEntry[]>(() => db.vocabulary.toArray(), [], []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void workspaceStore.list().then(setWorkspaces);
    // Names from workspaces, products and people are seeds: bring them up to date when the list is opened
    void api.request({ type: 'vocab_sync' }).catch(() => {});
  }, [api]);

  const nameOf = (id: string | null) => (id ? (workspaces.find(w => w.id === id)?.name ?? id) : t('vocab_scope_all'));
  const spellings = entries
    .filter(entry => !entry.never)
    .sort(
      (a, b) => Number(a.learnedFrom === 'seed') - Number(b.learnedFrom === 'seed') || a.write.localeCompare(b.write),
    );
  const never = entries.filter(entry => entry.never);

  const save = async (draft: Draft) => {
    const reply = await api.request<{ ok?: boolean; message?: string; refused?: string[] }>({
      type: 'vocab_save',
      id: draft.id,
      write: draft.write,
      heardAs: splitHeard(draft.heard),
      workspaceId: draft.workspaceId,
    });
    setProblem(reply.refused?.length ? t('vocab_refused', [reply.refused.map(word => `"${word}"`).join(', ')]) : '');
    setEditing(null);
  };
  const remove = (id: string) => void api.request({ type: 'vocab_delete', id }).catch(() => {});

  return (
    <>
      <div className={ROW}>
        <p className={HINT}>{t('vocab_hint')}</p>
        <EntryForm
          draft={{ write: '', heard: '', workspaceId: null }}
          workspaces={workspaces}
          submitLabel={t('vocab_add')}
          onSubmit={save}
        />
        {problem && (
          <p role="status" className="text-[12px] text-amber-600 dark:text-amber-400">
            {problem}
          </p>
        )}
      </div>
      {spellings.length === 0 && never.length === 0 && (
        <div className={ROW}>
          <p className={HINT}>{t('vocab_empty')}</p>
        </div>
      )}
      <ul aria-label={t('vocab_section')} className="flex flex-col">
        {spellings.map(entry => (
          <li key={entry.id} className={`${ROW} border-t`}>
            {editing === entry.id ? (
              <EntryForm
                draft={{
                  id: entry.id,
                  write: entry.write,
                  heard: entry.heardAs.join(', '),
                  workspaceId: entry.workspaceId,
                }}
                workspaces={workspaces}
                submitLabel={t('vocab_save')}
                onSubmit={save}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-medium">{entry.write}</span>
                  <span className={HINT}>{t('vocab_uses', [String(entry.uses)])}</span>
                </div>
                {entry.heardAs.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {entry.heardAs.map(word => (
                      <span key={word} className="bg-secondary rounded-full border px-2 py-0.5 font-mono text-[11px]">
                        {word}
                      </span>
                    ))}
                  </div>
                )}
                <p className={HINT}>
                  {nameOf(entry.workspaceId)}
                  {entry.learnedFrom === 'seed' && ` · ${t('vocab_from_seed')}`}
                  {entry.learnedFrom === 'correction' && ` · ${t('vocab_from_correction')}`}
                </p>
                <div className="flex gap-2">
                  <button type="button" className={BUTTON} onClick={() => setEditing(entry.id)}>
                    {t('vocab_edit')}
                  </button>
                  <button type="button" className={BUTTON} onClick={() => remove(entry.id)}>
                    {t('vocab_delete')}
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {never.length > 0 && (
        <div className={`${ROW} border-t`}>
          <p className="text-[12.5px]">{t('vocab_never_title')}</p>
          <div className="flex flex-wrap gap-1.5">
            {never.map(entry => (
              <span
                key={entry.id}
                className="bg-secondary flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 font-mono text-[11px]">
                {entry.write}
                <button
                  type="button"
                  className="hover:bg-accent rounded-full px-1"
                  aria-label={`${t('vocab_delete')} ${entry.write}`}
                  onClick={() => remove(entry.id)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
