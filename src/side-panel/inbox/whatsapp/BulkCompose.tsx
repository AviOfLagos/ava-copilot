import { useMemo, useRef, useState } from 'react';
import { Paperclip, Upload, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { BULK_MAX_ATTACHMENT_BYTES, parseCsv, prepareBatch } from '@extension/storage';
import type { BulkSettings } from '@extension/storage';
import { Button } from '../../components/ui/button';
import type { PanelApi } from '../../registry';
import { reasonText, useBulkSettings, useRemainingToday } from './useBulk';

interface Attachment {
  name: string;
  type: string;
  base64: string;
  size: number;
}

const FIELD =
  'bg-secondary text-foreground w-full rounded-xl px-3 py-2 text-[12.5px] outline-none focus:ring-1 focus:ring-primary/50';
const PREVIEW_ROWS = 3;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** One number setting, saved through the background when it changes. */
function NumberSetting({
  label,
  value,
  onSave,
  min,
  max,
}: {
  label: string;
  value: number;
  onSave: (value: number) => void;
  min: number;
  max: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex flex-col gap-1 text-[11.5px]">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft))) onSave(Number(draft));
          setDraft(null);
        }}
        className={FIELD}
      />
    </label>
  );
}

/** Paste or import a list, write the message, set the pacing, and ask for the review of the whole batch. */
export default function BulkCompose({ api }: { api: PanelApi }) {
  const settings = useBulkSettings();
  const remaining = useRemainingToday(settings.dailyCap);
  const [csv, setCsv] = useState('');
  const [template, setTemplate] = useState(t('inbox_wa_bulk_templateDefault'));
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  const preview = useMemo(() => {
    if (!csv.trim()) return null;
    try {
      const table = parseCsv(csv);
      return { table, batch: prepareBatch(table, template) };
    } catch (problem) {
      return { error: problem instanceof Error ? problem.message : String(problem) };
    }
  }, [csv, template]);

  const saveSetting = (changes: Partial<BulkSettings>) => {
    void api
      .request({ type: 'wa_bulk_settings', changes })
      .catch(problem => setError(String(problem?.message ?? problem)));
  };

  const insertPlaceholder = (key: string) => {
    const area = templateRef.current;
    const token = `{{${key}}}`;
    if (!area) return setTemplate(value => value + token);
    const start = area.selectionStart ?? template.length;
    const end = area.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setCsv(await file.text());
  };

  const pickAttachment = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > BULK_MAX_ATTACHMENT_BYTES) {
      setError(t('inbox_wa_error_attachmentTooBig'));
      return;
    }
    setAttachment({ name: file.name, type: file.type, size: file.size, base64: await readFileAsBase64(file) });
  };

  const review = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.request(
        {
          type: 'wa_bulk_create',
          csv,
          template,
          attachment: attachment ? { name: attachment.name, type: attachment.type, base64: attachment.base64 } : null,
        },
        30_000,
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const batch = preview && 'batch' in preview ? (preview.batch ?? null) : null;
  const headers = preview && 'table' in preview ? (preview.table?.headers ?? []) : [];
  const toSend = batch ? batch.recipients.filter(recipient => recipient.status === 'pending') : [];
  const skipped = batch ? batch.recipients.length - toSend.length : 0;

  return (
    <div className="flex flex-col gap-3">
      <div
        role="note"
        className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12px] leading-relaxed">
        {t('inbox_wa_bulk_warning')}
      </div>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="wa-bulk-csv" className="text-[12.5px] font-medium">
            {t('inbox_wa_bulk_list_label')}
          </label>
          <label className="glass hover:bg-accent inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11.5px]">
            <Upload className="size-3.5" aria-hidden />
            {t('inbox_wa_bulk_import')}
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              aria-label={t('inbox_wa_bulk_import')}
              onChange={event => void importCsv(event.target.files?.[0])}
            />
          </label>
        </div>
        <textarea
          id="wa-bulk-csv"
          value={csv}
          onChange={event => setCsv(event.target.value)}
          placeholder={'phone,name\n+2348012345678,Tomi'}
          rows={4}
          spellCheck={false}
          className={`${FIELD} font-mono text-[11.5px]`}
        />
        <p className="text-muted-foreground text-[11.5px]">{t('inbox_wa_bulk_list_hint')}</p>
        {preview && 'error' in preview && (
          <p role="alert" className="text-destructive text-[11.5px]">
            {t('inbox_wa_error_noPhoneColumn')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <label htmlFor="wa-bulk-template" className="text-[12.5px] font-medium">
          {t('inbox_wa_bulk_template_label')}
        </label>
        <textarea
          id="wa-bulk-template"
          ref={templateRef}
          value={template}
          onChange={event => setTemplate(event.target.value)}
          rows={3}
          className={FIELD}
        />
        {headers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-[11px]">{t('inbox_wa_bulk_insert')}</span>
            {headers.map(header => (
              <button
                key={header}
                type="button"
                onClick={() => insertPlaceholder(header)}
                className="glass hover:bg-accent rounded-full px-2 py-0.5 font-mono text-[10.5px]">
                {`{{${header}}}`}
              </button>
            ))}
          </div>
        )}
        {batch && batch.unknownPlaceholders.length > 0 && (
          <p role="alert" className="text-destructive text-[11.5px]">
            {t('inbox_wa_bulk_unknownPlaceholders', [batch.unknownPlaceholders.map(key => `{{${key}}}`).join(', ')])}
          </p>
        )}
      </section>

      <section className="flex items-center gap-2">
        {attachment ? (
          <span className="glass inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px]">
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{attachment.name}</span>
            <button
              type="button"
              aria-label={t('inbox_wa_bulk_attachment_remove')}
              onClick={() => setAttachment(null)}
              className="hover:text-foreground text-muted-foreground">
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : (
          <label className="glass hover:bg-accent inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px]">
            <Paperclip className="size-3.5" aria-hidden />
            {t('inbox_wa_bulk_attachment_add')}
            <input
              type="file"
              className="sr-only"
              aria-label={t('inbox_wa_bulk_attachment_add')}
              onChange={event => void pickAttachment(event.target.files?.[0])}
            />
          </label>
        )}
        <span className="text-muted-foreground text-[11px]">{t('inbox_wa_bulk_attachment_hint')}</span>
      </section>

      {batch && (
        <section className="flex flex-col gap-1.5" aria-label={t('inbox_wa_bulk_preview_title')}>
          <h3 className="text-[12.5px] font-medium">{t('inbox_wa_bulk_preview_title')}</h3>
          <p className="text-muted-foreground text-[11.5px]">
            {t('inbox_wa_bulk_preview_counts', [String(toSend.length), String(skipped)])}
          </p>
          <ul className="flex flex-col gap-1.5">
            {batch.recipients.slice(0, PREVIEW_ROWS).map((recipient, index) => (
              <li key={`${recipient.phone}-${index}`} className="glass rounded-xl px-3 py-2">
                <p className="text-[11.5px] font-medium">
                  {recipient.name || recipient.phone}{' '}
                  <span className="text-muted-foreground font-mono font-normal">+{recipient.phone}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed">
                  {recipient.status === 'pending' ? recipient.message : reasonText(recipient.reason)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="glass rounded-xl px-3 py-2">
        <summary className="cursor-pointer text-[12.5px] font-medium">{t('inbox_wa_bulk_pacing_title')}</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberSetting
            label={t('inbox_wa_bulk_delayMin')}
            value={settings.delayMinSec}
            min={1}
            max={3600}
            onSave={value => saveSetting({ delayMinSec: value })}
          />
          <NumberSetting
            label={t('inbox_wa_bulk_delayMax')}
            value={settings.delayMaxSec}
            min={1}
            max={3600}
            onSave={value => saveSetting({ delayMaxSec: value })}
          />
          <NumberSetting
            label={t('inbox_wa_bulk_cooldownEvery')}
            value={settings.cooldownEvery}
            min={1}
            max={1000}
            onSave={value => saveSetting({ cooldownEvery: value })}
          />
          <NumberSetting
            label={t('inbox_wa_bulk_dailyCap')}
            value={settings.dailyCap}
            min={1}
            max={200}
            onSave={value => saveSetting({ dailyCap: value })}
          />
          <NumberSetting
            label={t('inbox_wa_bulk_cooldownMin')}
            value={settings.cooldownMinSec}
            min={1}
            max={86400}
            onSave={value => saveSetting({ cooldownMinSec: value })}
          />
          <NumberSetting
            label={t('inbox_wa_bulk_cooldownMax')}
            value={settings.cooldownMaxSec}
            min={1}
            max={86400}
            onSave={value => saveSetting({ cooldownMaxSec: value })}
          />
        </div>
        <p className="text-muted-foreground mt-2 text-[11px]">{t('inbox_wa_bulk_pacing_hint')}</p>
      </details>

      <p className="text-muted-foreground text-[11.5px]">
        {t('inbox_wa_bulk_remainingToday', [String(remaining), String(settings.dailyCap)])}
      </p>

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      <Button disabled={busy || toSend.length === 0 || !template.trim()} onClick={() => void review()}>
        {t('inbox_wa_bulk_review', [String(toSend.length)])}
      </Button>
    </div>
  );
}
