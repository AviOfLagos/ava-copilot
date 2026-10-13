import { useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { t } from '@extension/i18n';
import type { Place } from '../layout/Sidebar';
import { displayPhrase, useAssistantName, useWakeChoice } from '../hooks/useAssistant';

// Everyday things to do, and where each lives; the words come from help_<id>_q and help_<id>_where
const TASKS: { id: string; place: Place }[] = [
  { id: 'task', place: 'chat' },
  { id: 'voice', place: 'chat' },
  { id: 'wake', place: 'settings' },
  { id: 'notes', place: 'meetings' },
  { id: 'call', place: 'chat' },
  { id: 'pastmeeting', place: 'meetings' },
  { id: 'calendar', place: 'settings' },
  { id: 'ask', place: 'memory' },
  { id: 'save', place: 'memory' },
  { id: 'skill', place: 'skills' },
  { id: 'find', place: 'chat' },
  { id: 'manage', place: 'chat' },
  { id: 'models', place: 'models' },
  { id: 'cap', place: 'settings' },
  { id: 'confirm', place: 'settings' },
  { id: 'form', place: 'chat' },
  { id: 'popout', place: 'chat' },
  { id: 'today', place: 'today' },
  // Wave 2 places: absent until the owning stream registers them, per `registeredPlaces`
  { id: 'workflows', place: 'workflows' },
  { id: 'inbox', place: 'inbox' },
  { id: 'agents', place: 'agents' },
  { id: 'connectors', place: 'connectors' },
  { id: 'defaultWorkspace', place: 'workspaces' },
  { id: 'readAloud', place: 'settings' },
];

type Key = Parameters<typeof t>[0];

/** "How do I…": every everyday task, searchable, with where it lives and a way straight there. */
export default function HelpView({ onGo }: { onGo: (place: Place) => void }) {
  const [query, setQuery] = useState('');
  const name = useAssistantName();
  // "Hey Ava", or "Hey <name>" when the wake word follows the name
  const phrase = [displayPhrase(useWakeChoice(name), name)];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tasks = TASKS.map(task => ({
    ...task,
    q: t(`help_${task.id}_q` as Key, phrase),
    where: t(`help_${task.id}_where` as Key, phrase),
  })).filter(task => words.every(word => `${task.q} ${task.where}`.toLowerCase().includes(word)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <label className="glass flex items-center gap-2 rounded-xl px-3 py-2">
        <Search className="text-muted-foreground size-4 shrink-0" />
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('help_search')}
          aria-label={t('help_search')}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none"
        />
      </label>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 && <li className="text-muted-foreground p-2 text-[12.5px]">{t('help_none')}</li>}
        {tasks.map(task => (
          <li key={task.id} className="border-border/50 flex items-center gap-2 border-b px-1 py-2 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{task.q}</p>
              <p className="text-muted-foreground text-[12px]">{task.where}</p>
            </div>
            <button
              type="button"
              onClick={() => onGo(task.place)}
              aria-label={`${t('help_go')}: ${task.q}`}
              className="text-muted-foreground hover:bg-accent flex size-8 shrink-0 items-center justify-center rounded-lg hover:text-foreground">
              <ArrowRight className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
