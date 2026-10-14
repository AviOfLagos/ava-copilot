import { Check, Settings2 } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  allPersonalities,
  DEFAULT_PERSONALITY_ID,
  personalityStore,
  resolvePersonality,
  switchesWorkspace,
} from '@extension/storage';
import { cn } from '@extension/ui';
import {
  RowMenu,
  RowMenuContent,
  RowMenuItem,
  RowMenuLabel,
  RowMenuSeparator,
  RowMenuTrigger,
} from '../components/ui/row-menu';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { personalityDescription, personalityName, usePersonalities } from './usePersonalities';

interface PersonalityPickerProps {
  // The workspace of the chat in front (or of the next new chat); a switch there changes its own default if it has one
  workspaceId: string | null;
  // Opens Settings, where personalities are made and edited
  onManage: () => void;
}

/**
 * The header's quick switch: the personality in force shows as its emoji; the menu lists every personality.
 */
export default function PersonalityPicker({ workspaceId, onManage }: PersonalityPickerProps) {
  const state = usePersonalities();
  const workspaces = useWorkspaces();
  const current = resolvePersonality(state, workspaceId);
  const scoped = switchesWorkspace(state, workspaceId);
  const workspaceName = scoped ? workspaces.find(item => item.id === workspaceId)?.name : undefined;
  const label = t('persona_picker_label', [personalityName(current)]);
  const plain = current.id === DEFAULT_PERSONALITY_ID;

  return (
    <RowMenu>
      <RowMenuTrigger
        aria-label={label}
        title={label}
        data-testid="personality-picker"
        className={cn(
          'flex h-7 shrink-0 items-center justify-center rounded-full text-[14px] leading-none transition-colors hover:bg-accent',
          plain ? 'w-7' : 'border-primary/40 bg-primary/10 gap-1 border px-1.5',
        )}>
        <span aria-hidden="true">{current.icon}</span>
      </RowMenuTrigger>
      <RowMenuContent align="start" className="w-[260px] max-w-[calc(100vw-24px)]">
        <RowMenuLabel className="label-mono px-2.5 pb-1 pt-1.5">
          {workspaceName ? t('persona_picker_title_workspace', [workspaceName]) : t('persona_picker_title')}
        </RowMenuLabel>
        <div className="max-h-[320px] overflow-y-auto">
          {allPersonalities(state).map(personality => {
            const selected = personality.id === current.id;
            return (
              <RowMenuItem
                key={personality.id}
                role="menuitemradio"
                aria-checked={selected}
                onSelect={() => void personalityStore.setActive(personality.id, workspaceId)}
                className="items-start">
                <span aria-hidden="true" className="mt-0.5 w-5 shrink-0 text-center text-[14px]">
                  {personality.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{personalityName(personality)}</span>
                  <span className="text-muted-foreground line-clamp-2 block text-[11px] leading-snug">
                    {personalityDescription(personality)}
                  </span>
                </span>
                <Check className={cn('text-primary mt-1 size-3.5 shrink-0', !selected && 'invisible')} />
              </RowMenuItem>
            );
          })}
        </div>
        <RowMenuSeparator />
        <RowMenuItem onSelect={onManage}>
          <Settings2 className="text-muted-foreground size-3.5" />
          {t('persona_picker_manage')}
        </RowMenuItem>
      </RowMenuContent>
    </RowMenu>
  );
}
