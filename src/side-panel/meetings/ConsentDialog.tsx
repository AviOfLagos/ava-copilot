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
      className={`m-3 rounded-lg border-2 border-red-500 p-4 text-sm ${isDarkMode ? 'bg-slate-900 text-gray-200' : 'bg-white text-gray-800'}`}>
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
          className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white">
          {t('meeting_consent_start')}
        </button>
      </div>
    </div>
  );
}
