import { useState } from 'react';
import { Users } from 'lucide-react';
import { t } from '@extension/i18n';
import type { AgentProfile } from '@extension/storage';
import { Button } from '../components/ui/button';

type Outcome =
  | { state: 'done' | 'already'; status: 'done' | 'skipped' | 'failed'; reason: string | null }
  | { state: 'running' }
  | { state: 'none'; reason: string };

/**
 * On the Growth Lead's page: when the plan and the standup run, and a button to run today's standup now (it still
 * runs once a day). The result goes to the Inbox as "Growth standup" (src/background/growth-team/standup).
 */
export function StandupButton({ agent }: { agent: AgentProfile }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  if (agent.template !== 'growth_lead' || agent.status === 'draft' || !agent.workspaceId) return null;

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const reply: { type?: string; result?: Outcome; error?: string } | undefined = await chrome.runtime.sendMessage({
        type: 'gteam_standup_run',
        workspaceId: agent.workspaceId,
        requestId: crypto.randomUUID(),
      });
      const outcome = reply?.result;
      if (!outcome) throw new Error(reply?.error ?? 'No answer');
      if (outcome.state === 'running') setMessage({ error: false, text: t('agents_standup_running') });
      else if (outcome.state === 'none')
        setMessage({ error: true, text: t('agents_standup_notRun', [outcome.reason]) });
      else if (outcome.status !== 'done')
        setMessage({ error: true, text: t('agents_standup_notRun', [outcome.reason ?? '']) });
      else
        setMessage({
          error: false,
          text: outcome.state === 'already' ? t('agents_standup_already') : t('agents_standup_done'),
        });
    } catch (problem) {
      setMessage({ error: true, text: problem instanceof Error ? problem.message : String(problem) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass flex flex-col gap-2 rounded-xl p-3" data-standup>
      <p className="text-muted-foreground text-[12px] leading-relaxed">{t('agents_standup_hint')}</p>
      <Button
        size="sm"
        variant="glass"
        className="self-start"
        disabled={busy}
        onClick={() => void run()}
        data-standup-run>
        <Users className="size-3.5" aria-hidden />
        {t('agents_standup_run')}
      </Button>
      {message && (
        <p role={message.error ? 'alert' : 'status'} className="text-[12px] leading-relaxed" data-standup-message>
          {message.text}
        </p>
      )}
    </section>
  );
}
