import { z } from 'zod';
import { db, threadStore, ttsSettingsStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { createLogger } from '../log';
import { registerCommand, registerOffscreenBusy } from '../registry';
import { services } from '../registry/services';
import { shouldAutoSpeak } from './decision';
import * as geminiEngine from './geminiEngine';
import { retryFromMessage } from './retry';
import { speak, stopSpeaking } from './speak';

const logger = createLogger('tts');

// ── Panel commands ────────────────────────────────────────────────────────────────────────────────

registerCommand(
  'thread_retry',
  z.object({ type: z.literal('thread_retry'), threadId: z.string(), windowId: z.number().optional() }),
  async input => {
    await services().threads.retry(input.threadId, input.windowId);
  },
);

registerCommand(
  'thread_retry_from',
  z.object({
    type: z.literal('thread_retry_from'),
    threadId: z.string(),
    seq: z.number().int().nonnegative(),
    windowId: z.number().optional(),
  }),
  async (input, context) => {
    try {
      const newThreadId = await retryFromMessage(
        threadStore,
        request => services().threads.send(request),
        input.threadId,
        input.seq,
        input.windowId,
      );
      context.reply({ type: 'thread_retry_from_ok', requestId: context.requestId, threadId: newThreadId });
    } catch (error) {
      context.reply({
        type: 'error',
        requestId: context.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

registerCommand(
  'speak_say',
  z.object({
    type: z.literal('speak_say'),
    threadId: z.string(),
    messageId: z.string(),
    text: z.string().max(20_000),
  }),
  async input => {
    try {
      await speak(input.text, { threadId: input.threadId, messageId: input.messageId });
    } catch (error) {
      logger.warning('Could not speak the answer', error);
    }
  },
);

registerCommand('speak_stop', z.object({ type: z.literal('speak_stop') }), async () => {
  await stopSpeaking();
});

// ── Offscreen document ───────────────────────────────────────────────────────────────────────────

// Only the Gemini engine uses the offscreen document (to play audio); system voices speak straight
// from the background. Keeps it open while that playback is going, same as the recorder and voice.
registerOffscreenBusy('tts', () => geminiEngine.speaking());

// The offscreen TTS player reporting a clip ended or failed; a separate listener from the voice
// session's own, filtered to its own message prefix so the two never interfere.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('tts_')) {
    return;
  }
  switch (message.type) {
    case 'tts_ended':
      geminiEngine.onEnded();
      break;
    case 'tts_error':
      geminiEngine.onError(String(message.error ?? 'Speech failed'));
      break;
  }
  return;
});

// ── Auto read-aloud ──────────────────────────────────────────────────────────────────────────────

async function maybeAutoSpeak(threadId: string, origin: ThreadRecord['origin']): Promise<void> {
  const settings = await ttsSettingsStore.getSettings();
  const messages = await threadStore.messages(threadId);
  const last = messages.at(-1);
  const should = shouldAutoSpeak({
    readAloud: settings.readAloud,
    threadOrigin: origin,
    lastMessageActor: last?.actor,
    voiceRunning: services().voice.running,
    lastSpokenMessageId: settings.lastSpokenMessageId,
    candidateMessageId: last?.id,
  });
  if (!should || !last) return;
  await ttsSettingsStore.updateSettings({ lastSpokenMessageId: last.id });
  await speak(last.content, { threadId, messageId: last.id });
}

// The background is the only writer of thread status, so its own write is the signal a run settled.
// A hook of its own, separate from the one in background/index.ts (which only feeds the knowledge base).
db.threads.hook('updating', (changes: Partial<ThreadRecord>, threadId: string, thread: ThreadRecord) => {
  if (changes.status !== 'idle') return;
  setTimeout(
    () => void maybeAutoSpeak(threadId, thread.origin).catch(error => logger.error('Auto-speak failed', error)),
  );
});
