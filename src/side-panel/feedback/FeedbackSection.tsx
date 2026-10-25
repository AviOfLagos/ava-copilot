import { Bug, Lightbulb } from 'lucide-react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { HINT } from '../settings/sections/ui';
import { browserInfo, describeBrowser, issueUrl } from './url';

/**
 * Settings › Help › Report a problem: opens GitHub's issue form with the version and browser filled in, so
 * whoever picks it up can reproduce it. Nothing is sent from the extension; the user submits on GitHub.
 */
export default function FeedbackSection() {
  const open = (kind: 'bug' | 'idea') => {
    const fields = {
      version: chrome.runtime.getManifest().version,
      browser: describeBrowser(browserInfo(navigator)),
    };
    void chrome.tabs.create({ url: issueUrl(kind, fields) });
  };
  return (
    <div className="flex flex-col gap-3 px-3 py-2.5">
      <p className="text-[13px]">{t('feedback_body')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="glass" size="sm" onClick={() => open('bug')}>
          <Bug className="mr-1.5 size-3.5" aria-hidden="true" />
          {t('feedback_bug')}
        </Button>
        <Button variant="glass" size="sm" onClick={() => open('idea')}>
          <Lightbulb className="mr-1.5 size-3.5" aria-hidden="true" />
          {t('feedback_idea')}
        </Button>
      </div>
      <p className={HINT}>{t('feedback_note')}</p>
    </div>
  );
}
