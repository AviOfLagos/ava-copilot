import { MODELS_PORT_NAME } from '@extension/storage';
import type { ModelsRequest } from './useProviders';

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Requests for pages without the panel's port (the full settings page): a port of their own to the
 * background, which only takes models_ commands on it. Unlike a broadcast message, nothing sent here (a
 * key being saved) reaches any other page.
 */
export function createPortRequest(
  messages: { timeout: string; disconnected: string } = {
    timeout: 'No answer came in time. Try again.',
    disconnected: 'The extension restarted. Try again.',
  },
): ModelsRequest {
  let port: chrome.runtime.Port | null = null;
  const pending = new Map<string, Pending>();

  const connect = (): chrome.runtime.Port => {
    if (port) return port;
    const next = chrome.runtime.connect({ name: MODELS_PORT_NAME });
    next.onMessage.addListener((message: Record<string, unknown>) => {
      const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      if (message.type === 'error') entry.reject(new Error(String(message.error ?? messages.disconnected)));
      else entry.resolve(message);
    });
    next.onDisconnect.addListener(() => {
      port = null;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(messages.disconnected));
      }
      pending.clear();
    });
    port = next;
    return next;
  };

  return <T = Record<string, unknown>>(message: Record<string, unknown>, timeoutMs = 30_000) =>
    new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(messages.timeout));
      }, timeoutMs);
      pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      try {
        connect().postMessage({ ...message, requestId });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
}
