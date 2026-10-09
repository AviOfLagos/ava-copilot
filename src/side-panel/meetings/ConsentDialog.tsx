import { useState } from 'react';
import { t } from '@extension/i18n';

interface ConsentDialogProps {
  includeMic: boolean;
  onStart: (includeMic: boolean) => void;
  onCancel: () => void;
  isDarkMode?: boolean;
}

/**
 * Shown before the first recording: the people in the meeting should know notes are being taken.
 */
export default function ConsentDialog({ includeMic, onStart, onCancel, isDarkMode = false }: ConsentDialogProps) {
  const [withMic, setWithMic] = useState(includeMic);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      data-dark={isDarkMode || undefined}
      className="glass border-destructive/50 m-3 rounded-2xl p-4 text-[13px]">
      <h2 id="consent-title" className="mb-2 text-base font-semibold">
        {t('meeting_consent_title')}
      </h2>
      <p className="mb-3">{t('meeting_consent_body')}</p>
      <label className="mb-4 flex items-center gap-2">
        <input type="checkbox" checked={withMic} onChange={e => setWithMic(e.target.checked)} />
        {t('meeting_consent_mic')}
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5">
          {t('meeting_consent_cancel')}
        </button>
        <button
          type="button"
          onClick={() => onStart(withMic)}
          className="border-destructive/60 bg-destructive/25 h-9 rounded-full border px-4 font-medium">
          {t('meeting_consent_start')}
        </button>
      </div>
    </div>
  );
}
