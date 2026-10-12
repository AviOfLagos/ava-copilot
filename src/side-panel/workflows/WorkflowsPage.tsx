import { useEffect, useMemo } from 'react';
import { t } from '@extension/i18n';
import RouteBoundary from '../components/RouteBoundary';
import { useTheme } from '../layout/theme';
import type { PanelApi } from '../registry';
import { WorkflowsView } from './WorkflowsPlace';

/**
 * The full-tab workflow editor (workflows.html): the same views as the panel's Workflows place, with room
 * for a big diagram. It talks to the background with one-off messages, through the same registered commands.
 */

function messageApi(): PanelApi {
  return {
    // Chats and other places live in the side panel
    go: () => {},
    openThread: () => {},
    startThread: () => {},
    post: message => void chrome.runtime.sendMessage(message).catch(() => {}),
    request: <T,>(message: Record<string, unknown>, timeoutMs = 30_000) =>
      new Promise<T>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => reject(new Error(t('errors_timeout'))), timeoutMs);
        chrome.runtime.sendMessage({ ...message, requestId }).then(
          (reply: Record<string, unknown> | undefined) => {
            window.clearTimeout(timer);
            if (!reply || reply.type === 'error') reject(new Error(String(reply?.error ?? t('errors_unknown'))));
            else resolve(reply as T);
          },
          error => {
            window.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
  };
}

export default function WorkflowsPage() {
  useTheme();
  const api = useMemo(messageApi, []);
  const initialId = decodeURIComponent(window.location.hash.slice(1)) || null;
  useEffect(() => {
    document.title = t('flow_page_title');
  }, []);
  return (
    <div className="aura flex min-h-screen justify-center">
      <main className="flex w-full max-w-4xl flex-col py-4">
        <RouteBoundary>
          <WorkflowsView api={api} initialId={initialId} wide />
        </RouteBoundary>
      </main>
    </div>
  );
}
