import { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  ArrowDownUp,
  BookOpen,
  Check,
  Clock,
  Copy,
  Globe,
  GitBranch,
  Keyboard,
  ListTree,
  MousePointerClick,
  PanelTop,
  Route,
  Search,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { t } from '@extension/i18n';
import type { ConfirmRequest, ThreadMessage, ThreadRecord } from '@extension/storage';
import { Conversation, ConversationContent, ConversationScrollButton } from '../components/ai/conversation';
import { Message, MessageActions, MessageContent, MessageResponse } from '../components/ai/message';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '../components/ai/chain-of-thought';
import type { StepStatus } from '../components/ai/chain-of-thought';
import { Shimmer } from '../components/ai/shimmer';
import { ThinkingOrb } from '../components/ui/thinking-orb';
import { Button } from '../components/ui/button';
import { duration, toTurns } from './turns';
import type { StepKind, Turn } from './turns';

const STEP_ICONS: Record<StepKind, LucideIcon> = {
  plan: Route,
  click: MousePointerClick,
  navigate: Globe,
  type: Keyboard,
  search: Search,
  read: BookOpen,
  scroll: ArrowDownUp,
  wait: Clock,
  tab: PanelTop,
  note: Sparkles,
  error: AlertTriangle,
  step: Workflow,
};

const HELD_LABELS = {
  send: 'gate_kind_send',
  publish: 'gate_kind_publish',
  submit: 'gate_kind_submit',
  delete: 'gate_kind_delete',
  purchase: 'gate_kind_purchase',
  permission: 'gate_kind_permission',
  login: 'gate_needsUser_login',
  captcha: 'gate_needsUser_captcha',
  code: 'gate_needsUser_code',
  cap: 'gate_needsUser_cap',
} as const;

// The thinking orb's light program for what the agent is doing
const ACTIVITY_PROGRAM: Record<string, number> = { planning: 0, navigating: 1 };

interface ChatViewProps {
  thread: ThreadRecord;
  messages: ThreadMessage[];
  onBranch?: (seq: number) => void;
  footer?: React.ReactNode;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('chat_copy')}
      title={t('chat_copy')}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function RunTrail({
  turn,
  held,
  activity,
  open,
}: {
  turn: Turn;
  held: ConfirmRequest | null;
  activity: string;
  open: boolean;
}) {
  const steps = turn.steps;
  const count = steps.length + (held ? 1 : 0);
  const working = turn.active && !held;
  return (
    <ChainOfThought defaultOpen={open}>
      <ChainOfThoughtHeader
        icon={<ListTree className="size-4" />}
        meta={turn.active ? undefined : duration(turn.endedAt - turn.startedAt)}>
        <span className="label-mono">{t('chat_run_steps', [String(count)])}</span>
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1 && !held;
          const status: StepStatus = step.kind === 'error' ? 'failed' : working && isLast ? 'active' : 'complete';
          return (
            <ChainOfThoughtStep
              key={step.id}
              icon={STEP_ICONS[step.kind]}
              status={status}
              last={isLast && !working}
              label={
                status === 'active' ? (
                  <Shimmer as="span" duration={2.4}>
                    {step.text}
                  </Shimmer>
                ) : step.kind === 'plan' ? (
                  <MessageResponse className="text-muted-foreground text-[13px]">{step.text}</MessageResponse>
                ) : (
                  step.text
                )
              }
            />
          );
        })}
        {held && (
          <ChainOfThoughtStep
            status="held"
            last
            label={t('chat_run_held', [t(HELD_LABELS[held.kind])])}
            description={held.target || undefined}
          />
        )}
        {working && (
          <div className="flex items-center gap-2 pl-0.5 pt-1">
            <ThinkingOrb size={26} program={ACTIVITY_PROGRAM[activity] ?? 2} />
            <Shimmer as="span" className="text-[12.5px]">
              {activity === 'planning' ? t('chat_run_planning') : t('chat_run_working')}
            </Shimmer>
          </div>
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

/**
 * A thread as a conversation: each request, its run drawn as a trail of steps, and the answer.
 * The newest run stays open; older ones fold to one line.
 */
export default function ChatView({ thread, messages, onBranch, footer }: ChatViewProps) {
  const running = thread.status === 'running' || thread.status === 'waiting_confirm';
  const turns = useMemo(() => toTurns(messages, running), [messages, running]);

  return (
    <Conversation className="min-h-0">
      <ConversationContent>
        {turns.map((turn, index) => {
          const latest = index === turns.length - 1;
          const held = latest && turn.active ? thread.pendingRequest : null;
          const showTrail = turn.steps.length > 0 || (latest && turn.active);
          return (
            <div key={turn.id} className="flex flex-col gap-3">
              {turn.request && (
                <Message from="user">
                  <MessageContent>
                    <p className="whitespace-pre-wrap break-words">{turn.request.content}</p>
                  </MessageContent>
                  {onBranch && (
                    <MessageActions>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('threads_branch')}
                        title={t('threads_branch')}
                        onClick={() => onBranch(turn.request!.seq)}>
                        <GitBranch className="size-3.5" />
                      </Button>
                    </MessageActions>
                  )}
                </Message>
              )}
              {showTrail && <RunTrail turn={turn} held={held} activity={thread.activity} open={latest} />}
              {turn.answer && (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse>{turn.answer.content}</MessageResponse>
                  </MessageContent>
                  <MessageActions>
                    <CopyButton text={turn.answer.content} />
                    {onBranch && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('threads_branch')}
                        title={t('threads_branch')}
                        onClick={() => onBranch(turn.answer!.seq)}>
                        <GitBranch className="size-3.5" />
                      </Button>
                    )}
                  </MessageActions>
                </Message>
              )}
            </div>
          );
        })}
        {footer}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
