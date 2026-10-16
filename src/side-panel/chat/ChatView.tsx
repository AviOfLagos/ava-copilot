import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  RotateCcw,
  Route,
  Search,
  Sparkles,
  Square,
  Volume2,
  Workflow,
} from 'lucide-react';
import { t } from '@extension/i18n';
import { ttsSpeakingStore } from '@extension/storage';
import type { ConfirmRequest, ThreadMessage, ThreadRecord } from '@extension/storage';
import { Conversation, ConversationContent, ConversationScrollButton } from '../components/ai/conversation';
import AttachmentStrip from '../attachments/AttachmentStrip';
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
import { useAssistantName } from '../hooks/useAssistant';
import { registeredTurnAddons } from '../registry';
import type { PanelApi } from '../registry';

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
  questions: 'gate_needsUser_questions',
  tool: 'conn_gate_kind',
} as const;

// The thinking orb's light program for what the agent is doing
const ACTIVITY_PROGRAM: Record<string, number> = { planning: 0, navigating: 1 };

interface ChatViewProps {
  thread: ThreadRecord;
  messages: ThreadMessage[];
  onBranch?: (seq: number) => void;
  // Re-runs the thread's last task with a fresh agent; shown when the thread is idle or errored
  onRetry?: () => void;
  // Forks the thread just before a user message and sends it again
  onRetryFrom?: (seq: number) => void;
  onSpeak?: (threadId: string, messageId: string, text: string) => void;
  onStopSpeaking?: () => void;
  footer?: React.ReactNode;
  // For what features show under a turn (registerTurnAddon), e.g. opening an agent's chat
  api?: PanelApi;
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
  const name = useAssistantName();
  const steps = turn.steps;
  const count = steps.length + (held ? 1 : 0);
  const working = turn.active && !held;
  return (
    <ChainOfThought defaultOpen={open}>
      <ChainOfThoughtHeader
        icon={<ListTree className="size-4" />}
        meta={turn.active ? undefined : duration(turn.endedAt - turn.startedAt)}>
        <span className="label-mono">{t(count === 1 ? 'chat_run_steps_one' : 'chat_run_steps', [String(count)])}</span>
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
              {activity === 'planning' ? t('chat_run_planning', [name]) : t('chat_run_working')}
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
export default function ChatView({
  thread,
  messages,
  onBranch,
  onRetry,
  onRetryFrom,
  onSpeak,
  onStopSpeaking,
  footer,
  api,
}: ChatViewProps) {
  const running = thread.status === 'running' || thread.status === 'waiting_confirm';
  const idle = thread.status === 'idle' || thread.status === 'error';
  const turns = useMemo(() => toTurns(messages, running), [messages, running]);
  const name = useAssistantName();

  // Who is speaking right now, read live from storage the background writes to; null once nothing is
  useEffect(() => void ttsSpeakingStore.get(), []);
  const speakingMessageId =
    useSyncExternalStore(ttsSpeakingStore.subscribe, ttsSpeakingStore.getSnapshot)?.messageId ?? null;

  return (
    <Conversation className="min-h-0">
      <ConversationContent>
        {turns.map((turn, index) => {
          const latest = index === turns.length - 1;
          const held = latest && turn.active ? thread.pendingRequest : null;
          const showTrail = turn.steps.length > 0 || (latest && turn.active);
          const showFailedRetry = latest && !turn.active && !turn.answer && thread.status === 'error';
          const speakingThis = latest && !!turn.answer && speakingMessageId === turn.answer.id;
          return (
            <div key={turn.id} className="flex flex-col gap-3">
              {turn.request && (
                <Message from="user">
                  <MessageContent>
                    <p className="whitespace-pre-wrap break-words">{turn.request.content}</p>
                  </MessageContent>
                  {turn.request.attachments?.length ? <AttachmentStrip attachments={turn.request.attachments} /> : null}
                  {(onBranch || (onRetryFrom && idle)) && (
                    <MessageActions>
                      {onBranch && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('threads_branch')}
                          title={t('threads_branch')}
                          onClick={() => onBranch(turn.request!.seq)}>
                          <GitBranch className="size-3.5" />
                        </Button>
                      )}
                      {onRetryFrom && idle && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('retry_fromHere')}
                          title={t('retry_fromHere')}
                          onClick={() => onRetryFrom(turn.request!.seq)}>
                          <RotateCcw className="size-3.5" />
                        </Button>
                      )}
                    </MessageActions>
                  )}
                </Message>
              )}
              {showTrail && <RunTrail turn={turn} held={held} activity={thread.activity} open={latest} />}
              {registeredTurnAddons().map(([id, Addon]) => (
                <Addon key={id} thread={thread} requestSeq={turn.request?.seq ?? null} api={api} />
              ))}
              {showFailedRetry && onRetry && (
                <div className="pl-1">
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcw className="size-3.5" />
                    {t('retry_action')}
                  </Button>
                </div>
              )}
              {turn.answer && (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse>{turn.answer.content}</MessageResponse>
                  </MessageContent>
                  <MessageActions className={speakingThis ? 'h-7 opacity-100' : undefined}>
                    <CopyButton text={turn.answer.content} />
                    {onSpeak &&
                      (speakingThis ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('speak_stop')}
                          title={t('speak_stop')}
                          onClick={() => onStopSpeaking?.()}>
                          <Square className="size-3.5" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('speak_action')}
                          title={t('onboard_readAloud_title', [name])}
                          onClick={() => onSpeak(thread.id, turn.answer!.id, turn.answer!.content)}>
                          <Volume2 className="size-3.5" />
                        </Button>
                      ))}
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
                    {onRetry && latest && idle && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('retry_action')}
                        title={t('retry_action')}
                        onClick={onRetry}>
                        <RotateCcw className="size-3.5" />
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
