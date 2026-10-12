import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { RunStep } from '@extension/storage';
import { checkSchedule } from '@src/background/workflows/spec';
import type { WorkflowNode } from '@src/background/workflows/spec';
import { Button } from '../components/ui/button';
import type { PanelApi } from '../registry';
import { durationText, NODE_META, scheduleText, STATUS_LABEL } from './meta';

/**
 * One node, opened from the diagram: what it does, simple edits by hand (its name, a schedule, an
 * instruction), and, for a run, what the step took in, gave out, or why it failed.
 */

// The field each kind keeps its instruction in, when it has one the user may edit
function instructionOf(node: WorkflowNode): string | null {
  switch (node.type) {
    case 'step.llm':
      return node.instructions;
    case 'step.browse':
      return node.task;
    case 'step.web_search':
      return node.query;
    default:
      return null;
  }
}

const HIDDEN = new Set(['id', 'type', 'label', 'cron', 'timezone', 'instructions', 'task']);

function shown(value: unknown, max = 4000): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function outputText(output: unknown): string {
  const section = (output as { briefSection?: { markdown?: string } } | null)?.briefSection;
  return section?.markdown ?? shown(output);
}

const field =
  'border-input w-full rounded-lg border bg-transparent px-2 py-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]';

export interface NodeInspectorProps {
  workflowId: string;
  node: WorkflowNode;
  step?: RunStep;
  editable: boolean;
  api: PanelApi;
  onClose: () => void;
}

export default function NodeInspector({ workflowId, node, step, editable, api, onClose }: NodeInspectorProps) {
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const instruction = instructionOf(node);
  const [label, setLabel] = useState(node.label);
  const [cron, setCron] = useState(node.type === 'trigger.schedule' ? node.cron : '');
  const [timezone, setTimezone] = useState(node.type === 'trigger.schedule' ? node.timezone : '');
  const [text, setText] = useState(instruction ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setLabel(node.label);
    setCron(node.type === 'trigger.schedule' ? node.cron : '');
    setTimezone(node.type === 'trigger.schedule' ? node.timezone : '');
    setText(instructionOf(node) ?? '');
    setMessage(null);
  }, [node]);

  const schedule = node.type === 'trigger.schedule' ? checkSchedule(cron, timezone, Date.now()) : null;
  const changed =
    label.trim() !== node.label ||
    (node.type === 'trigger.schedule' && (cron.trim() !== node.cron || timezone.trim() !== node.timezone)) ||
    (instruction !== null && text.trim() !== instruction);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.request({
        type: 'workflow_edit_node',
        id: workflowId,
        nodeId: node.id,
        ...(label.trim() !== node.label ? { label: label.trim() } : {}),
        ...(node.type === 'trigger.schedule' && cron.trim() !== node.cron ? { cron: cron.trim() } : {}),
        ...(node.type === 'trigger.schedule' && timezone.trim() !== node.timezone ? { timezone: timezone.trim() } : {}),
        ...(instruction !== null && text.trim() !== instruction ? { instructions: text.trim() } : {}),
      });
      setMessage({ ok: true, text: t('flow_inspector_saved') });
    } catch (problem) {
      setMessage({ ok: false, text: problem instanceof Error ? problem.message : String(problem) });
    } finally {
      setBusy(false);
    }
  };

  const details = Object.entries(node).filter(
    ([key, value]) =>
      !HIDDEN.has(key) && value !== undefined && value !== '' && !(key === 'query' && instruction !== null),
  );

  return (
    <section aria-label={t('flow_inspector_a11y', [node.label])} className="glass rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="label-mono min-w-0 flex-1 truncate">{t(meta.label)}</span>
        <Button size="icon-sm" variant="ghost" aria-label={t('flow_inspector_close')} onClick={onClose}>
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>

      {editable ? (
        <form onSubmit={save} className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[11.5px]">
            <span className="text-muted-foreground">{t('flow_inspector_name')}</span>
            <input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} className={field} />
          </label>
          {node.type === 'trigger.schedule' && (
            <div className="flex flex-col gap-1">
              <div className="flex gap-1.5">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px]">
                  <span className="text-muted-foreground">{t('flow_inspector_cron')}</span>
                  <input
                    value={cron}
                    onChange={event => setCron(event.target.value)}
                    spellCheck={false}
                    className={`${field} font-mono`}
                  />
                </label>
                <label className="flex w-[42%] flex-col gap-1 text-[11.5px]">
                  <span className="text-muted-foreground">{t('flow_inspector_timezone')}</span>
                  <input
                    value={timezone}
                    onChange={event => setTimezone(event.target.value)}
                    spellCheck={false}
                    className={`${field} font-mono`}
                  />
                </label>
              </div>
              <p className="text-muted-foreground text-[11.5px]" aria-live="polite">
                {schedule && 'next' in schedule ? scheduleText(cron) : t('flow_inspector_badCron')}
              </p>
            </div>
          )}
          {instruction !== null && (
            <label className="flex flex-col gap-1 text-[11.5px]">
              <span className="text-muted-foreground">{t('flow_inspector_instructions')}</span>
              <textarea
                value={text}
                onChange={event => setText(event.target.value)}
                rows={4}
                className={`${field} resize-y`}
              />
            </label>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              variant="glass"
              disabled={busy || !changed || (schedule !== null && !('next' in schedule))}>
              {t('flow_save')}
            </Button>
            {message && (
              <span
                role={message.ok ? 'status' : 'alert'}
                className={message.ok ? 'text-muted-foreground text-[11.5px]' : 'text-destructive text-[11.5px]'}>
                {message.text}
              </span>
            )}
          </div>
        </form>
      ) : (
        <p className="mt-1.5 text-[13px] font-medium">{node.label}</p>
      )}

      {details.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          {details.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground font-mono">{key}</dt>
              <dd className="min-w-0 break-words font-mono">{shown(value, 600)}</dd>
            </div>
          ))}
        </dl>
      )}

      {step && (
        <div className="border-border/70 mt-2.5 border-t pt-2.5">
          <p className="text-[12px]">
            <span className="font-medium">{t(STATUS_LABEL[step.status])}</span>
            <span className="text-muted-foreground">
              {step.attempts > 1 ? ` · ${t('flow_inspector_attempts', [String(step.attempts)])}` : ''}
              {step.startedAt && step.endedAt ? ` · ${durationText(step.endedAt - step.startedAt)}` : ''}
              {step.tainted ? ` · ${t('flow_inspector_outside')}` : ''}
            </span>
          </p>
          {step.error && <p className="text-destructive mt-1 text-[12px]">{step.error.message}</p>}
          {step.output !== null && step.output !== undefined && step.status === 'succeeded' && (
            <>
              <p className="label-mono mt-2">{t('flow_inspector_output')}</p>
              <pre className="bg-secondary mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 font-mono text-[11px] leading-relaxed">
                {outputText(step.output)}
              </pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}
