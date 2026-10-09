import { useState } from 'react';
import type { ConfirmRequest } from '@extension/storage';
import { t } from '@extension/i18n';
import { Button } from './ui/button';
import { HoldButton } from './ui/hold-button';

interface ConfirmCardProps {
  request: ConfirmRequest;
  onAnswer: (approved: boolean, replies?: string[]) => void;
  isDarkMode?: boolean;
}

const KIND_LABELS = {
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
} as const;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The card that stops the agent before it commits something, or hands a step to the user. It shows
 * where the action goes and the content as read back from the page. Committing takes a hold or two
 * clicks; it is the only amber thing in the panel.
 */
/**
 * Everything the agent still needs for a form, asked at once: the user answers what they want and
 * the agent fills the rest in one go. A blank answer leaves that field empty.
 */
function QuestionsCard({ request, onAnswer }: ConfirmCardProps) {
  const questions = request.questions ?? [];
  const [replies, setReplies] = useState<string[]>(() => questions.map(() => ''));

  return (
    <form
      role="alertdialog"
      aria-labelledby="confirm-card-title"
      onSubmit={event => {
        event.preventDefault();
        onAnswer(true, replies);
      }}
      className="border-hold/45 from-hold/10 to-hold/[0.03] animate-in fade-in-0 slide-in-from-bottom-2 mb-2 rounded-[18px] border bg-gradient-to-b p-3.5 text-[13px] shadow-[0_0_0_4px_rgb(var(--hold-rgb)/0.06),0_12px_30px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-3">
        <h3 id="confirm-card-title" className="text-[14px] font-semibold leading-snug">
          {t('gate_card_questionsTitle', [String(questions.length)])}
        </h3>
        {request.pageUrl && (
          <span className="text-muted-foreground mt-0.5 shrink-0 font-mono text-[10.5px]">
            {hostOf(request.pageUrl)}
          </span>
        )}
      </div>
      {request.context && <p className="text-muted-foreground mt-1">{request.context}</p>}
      <div className="mt-2.5 flex max-h-72 flex-col gap-2.5 overflow-y-auto">
        {questions.map((question, index) => (
          <label key={`${question}-${index}`} className="flex flex-col gap-1">
            <span className="break-words font-medium">{question}</span>
            <input
              autoComplete="off"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={index === 0}
              value={replies[index] ?? ''}
              onChange={event =>
                setReplies(current => current.map((reply, at) => (at === index ? event.target.value : reply)))
              }
              className="glass rounded-xl px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/50"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="glass" size="lg" className="flex-1" onClick={() => onAnswer(false)}>
          {t('gate_card_skipQuestions')}
        </Button>
        <Button type="submit" variant="default" size="lg" className="flex-[1.4]">
          {t('gate_card_sendAnswers')}
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-center text-[11px]">{t('gate_card_questionsHint')}</p>
      <p className="mt-1 text-center text-[11px] font-medium">{t('gate_card_questionsNoSecrets')}</p>
    </form>
  );
}

export default function ConfirmCard({ request, onAnswer, isDarkMode }: ConfirmCardProps) {
  if (request.kind === 'questions') {
    return <QuestionsCard request={request} onAnswer={onAnswer} isDarkMode={isDarkMode} />;
  }
  const isCommit = request.mode === 'commit';
  const kindText = t(KIND_LABELS[request.kind]);

  return (
    <div
      role="alertdialog"
      aria-labelledby="confirm-card-title"
      className="border-hold/45 from-hold/10 to-hold/[0.03] animate-in fade-in-0 slide-in-from-bottom-2 mb-2 rounded-[18px] border bg-gradient-to-b p-3.5 text-[13px] shadow-[0_0_0_4px_rgb(var(--hold-rgb)/0.06),0_12px_30px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-3">
        <h3 id="confirm-card-title" className="text-[14px] font-semibold leading-snug">
          {isCommit ? t('gate_card_title', [kindText]) : t('gate_card_needsUserTitle')}
        </h3>
        {request.pageUrl && (
          <span className="text-muted-foreground mt-0.5 shrink-0 font-mono text-[10.5px]">
            {hostOf(request.pageUrl)}
          </span>
        )}
      </div>
      {!isCommit && <p className="text-muted-foreground mt-1">{kindText}</p>}
      {!isCommit && request.context && <p className="mt-1 font-medium">{request.context}</p>}

      <dl className="mt-2.5 grid grid-cols-[64px_1fr] gap-y-1">
        {request.pageTitle && (
          <>
            <dt className="text-muted-foreground font-mono text-[10.5px] leading-5">{t('gate_card_page')}</dt>
            <dd className="min-w-0 break-words">{request.pageTitle}</dd>
          </>
        )}
        {isCommit && request.target && (
          <>
            <dt className="text-muted-foreground font-mono text-[10.5px] leading-5">{t('gate_card_target')}</dt>
            <dd className="min-w-0 break-words font-medium">{request.target}</dd>
          </>
        )}
      </dl>

      {isCommit && (
        <div className="mt-2.5 max-h-60 overflow-y-auto rounded-xl bg-black/20 p-2.5">
          {request.fields.length === 0 && !request.context && (
            <p className="text-muted-foreground">{t('gate_card_noContent')}</p>
          )}
          {request.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className={index > 0 ? 'mt-2' : ''}>
              {field.label && <div className="text-muted-foreground font-mono text-[10.5px]">{field.label}</div>}
              <div className="whitespace-pre-wrap break-words">{field.value}</div>
            </div>
          ))}
          {request.context && (
            <p className={`whitespace-pre-wrap break-words ${request.fields.length > 0 ? 'mt-2' : ''}`}>
              {request.context}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button variant="glass" size="lg" className="flex-1" onClick={() => onAnswer(false)}>
          {isCommit ? t('gate_card_cancel') : t('gate_card_stop')}
        </Button>
        {isCommit ? (
          <HoldButton className="flex-[1.4]" onConfirm={() => onAnswer(true)} armedLabel={t('gate_card_confirmAgain')}>
            {t('gate_card_confirm')}
          </HoldButton>
        ) : (
          <Button variant="default" size="lg" className="flex-[1.4]" onClick={() => onAnswer(true)}>
            {t('gate_card_continue')}
          </Button>
        )}
      </div>
      {isCommit && <p className="text-muted-foreground mt-2 text-center text-[11px]">{t('gate_card_holdHint')}</p>}
    </div>
  );
}
