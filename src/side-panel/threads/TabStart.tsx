import { t } from '@extension/i18n';
import { threadStore } from '@extension/storage';
import { Globe, MessageSquarePlus } from 'lucide-react';
import { useLive } from '../hooks/useLive';
import { relativeTime } from '../inbox/meta';
import { pageOf } from './tabPanel';

const SHOWN = 6;

interface TabStartProps {
  // Puts the cursor in the chat box: the next message starts a new conversation on this tab
  onNew: () => void;
  // Opens a past conversation here: it lives on this tab from now on
  onOpen: (threadId: string) => void;
}

/**
 * What a tab with no conversation of its own shows: start a new one, or carry on with a past one here. Each past
 * conversation says which page it belongs to.
 */
export default function TabStart({ onNew, onOpen }: TabStartProps) {
  const threads = useLive(() => threadStore.list(), [], []);
  const recent = threads.filter(thread => thread.title).slice(0, SHOWN);

  return (
    <section aria-label={t('tabPanel_title')} className="glass mx-2.5 mt-2.5 space-y-2 rounded-2xl p-3">
      <button
        type="button"
        onClick={onNew}
        className="bg-primary text-primary-foreground flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium">
        <MessageSquarePlus className="size-4" />
        {t('tabPanel_new')}
      </button>
      {recent.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-muted-foreground px-1 text-[11px] font-medium">{t('tabPanel_previous')}</h3>
          <ul className="space-y-0.5">
            {recent.map(thread => {
              const page = pageOf(thread);
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(thread.id)}
                    className="hover:bg-accent w-full rounded-xl px-2 py-1.5 text-left">
                    <span className="block truncate text-[13px]">{thread.title}</span>
                    <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                      <Globe className="size-3 shrink-0" />
                      <span className="truncate">{page || t('tabPanel_noPage')}</span>
                      <span className="shrink-0">· {relativeTime(thread.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
