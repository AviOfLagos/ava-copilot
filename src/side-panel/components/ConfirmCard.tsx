import type { ConfirmRequest } from '@extension/storage';
import { t } from '@extension/i18n';

interface ConfirmCardProps {
  request: ConfirmRequest;
  onAnswer: (approved: boolean) => void;
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
} as const;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The card that stops the agent before it commits something, or hands a step to the user.
 * It shows where the action goes and the content as read back from the page.
 */
export default function ConfirmCard({ request, onAnswer, isDarkMode = false }: ConfirmCardProps) {
  const isCommit = request.mode === 'commit';
  const kindText = t(KIND_LABELS[request.kind]);
  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const box = isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-gray-200 bg-white';

  return (
    <div
      role="alertdialog"
      aria-labelledby="confirm-card-title"
      className={`mb-2 rounded-lg border-2 p-3 text-sm ${
        isDarkMode ? 'border-amber-500 bg-slate-900 text-gray-200' : 'border-amber-500 bg-amber-50 text-gray-900'
      }`}>
      <h3 id="confirm-card-title" className="text-base font-semibold">
        {isCommit ? t('gate_card_title', [kindText]) : t('gate_card_needsUserTitle')}
      </h3>
      {!isCommit && <p className="mt-1">{kindText}</p>}
      {!isCommit && request.context && <p className="mt-1 font-medium">{request.context}</p>}

      <dl className="mt-2 space-y-1">
        {request.pageUrl && (
          <div className="flex gap-2">
            <dt className={`w-16 shrink-0 ${muted}`}>{t('gate_card_page')}</dt>
            <dd className="min-w-0 break-words">
              {request.pageTitle && <span className="font-medium">{request.pageTitle} </span>}
              <span className={muted}>{hostOf(request.pageUrl)}</span>
            </dd>
          </div>
        )}
        {isCommit && request.target && (
          <div className="flex gap-2">
            <dt className={`w-16 shrink-0 ${muted}`}>{t('gate_card_target')}</dt>
            <dd className="min-w-0 break-words font-medium">{request.target}</dd>
          </div>
        )}
      </dl>

      {isCommit && (
        <div className={`mt-2 max-h-60 overflow-y-auto rounded border p-2 ${box}`}>
          {request.fields.length === 0 && !request.context && <p className={muted}>{t('gate_card_noContent')}</p>}
          {request.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className={index > 0 ? 'mt-2' : ''}>
              {field.label && <div className={`text-xs ${muted}`}>{field.label}</div>}
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

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className={`rounded-md border px-3 py-1.5 font-medium ${
            isDarkMode ? 'border-slate-500 hover:bg-slate-700' : 'border-gray-300 bg-white hover:bg-gray-100'
          }`}>
          {isCommit ? t('gate_card_cancel') : t('gate_card_stop')}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700">
          {isCommit ? t('gate_card_confirm') : t('gate_card_continue')}
        </button>
      </div>
    </div>
  );
}
