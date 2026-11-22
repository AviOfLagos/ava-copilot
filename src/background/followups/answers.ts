import { t } from '@extension/i18n';
import { isoDay, taskStore } from '@extension/storage';
import type { Task } from '@extension/storage';
import { plainOutside } from '../whatsapp-remote/format';
import { taskListText } from '../whatsapp-remote/task-desk';
import type { ReportResult } from './report';
import { dayLabel } from './status';

/**
 * Ava's answer on WhatsApp to "ada says …" (docs/pm-desk.md, Part 9.3): what she kept, when she will remind him,
 * and, when what they finished matches open tasks of theirs, those tasks numbered so "done 1" closes one. Only his
 * answer closes a task. Plain text, no formatting a name could break.
 */
export async function reportAnswer(
  result: ReportResult,
  now: number,
  getTask: (id: string) => Promise<Task | undefined> = id => taskStore.get(id),
): Promise<{ text: string; taskIds: string[] }> {
  if (result.kind !== 'saved') return { text: t('followups_wa_notSaved'), taskIds: [] };
  const name = plainOutside(result.person.name, 40).replace(/_/g, ' ');
  const lines = [t('followups_wa_saved', [name])];
  if (result.update.by) lines.push(t('followups_wa_by', [dayLabel(result.update.by)]));
  const next = result.moved.length ? Math.min(...result.moved.map(item => item.nextAt)) : null;
  if (next) lines.push(t('followups_wa_nextFollowUp', [dayLabel(isoDay(next))]));
  const offered: Task[] = [];
  for (const offer of result.update.offers ?? []) {
    const task = await getTask(offer.taskId);
    if (task?.status === 'open') offered.push(task);
  }
  if (!offered.length) return { text: lines.join('\n'), taskIds: [] };
  const list = taskListText(t('followups_wa_didTitle', [name]), offered, { now, owner: false, hint: false });
  return { text: [lines.join('\n'), list.text, `_${t('followups_wa_didHint')}_`].join('\n\n'), taskIds: list.taskIds };
}
