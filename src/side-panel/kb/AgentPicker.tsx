import { Users } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { AgentProfile } from '@extension/storage';
import { cn } from '@extension/ui';
import { useLive } from '../hooks/useLive';

/**
 * The agents in a workspace (plus any with none), for filtering knowledge by who it came from.
 * Reads `db.agents` directly: there is no agent store yet (Wave 2's agents stream builds one), and
 * nothing here writes, so the raw table is enough.
 */
export function useAgents(workspaceId: string | null): AgentProfile[] {
  return useLive(
    () =>
      db.agents
        .filter(agent => workspaceId == null || agent.workspaceId === workspaceId || agent.workspaceId === null)
        .toArray(),
    [workspaceId],
    [] as AgentProfile[],
  );
}

interface AgentPickerProps {
  workspaceId: string | null;
  value: string | null;
  onChange: (agentId: string | null) => void;
  className?: string;
}

/** A chip that narrows knowledge to one agent's work. Hides itself when there are no agents yet. */
export default function AgentPicker({ workspaceId, value, onChange, className }: AgentPickerProps) {
  const agents = useAgents(workspaceId);
  if (agents.length === 0) return null;
  return (
    <label
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px]',
        value && 'border-primary/40',
        className,
      )}>
      <Users className={cn('size-3 shrink-0', value ? 'text-primary' : 'text-muted-foreground')} />
      <span className="sr-only">{t('graph_agent_label')}</span>
      <select
        value={value ?? ''}
        onChange={event => onChange(event.target.value || null)}
        className="text-foreground min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[11px] outline-none">
        <option value="">{t('graph_agent_all')}</option>
        {agents.map(agent => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </label>
  );
}
