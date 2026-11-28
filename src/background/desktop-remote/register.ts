// The Ava desktop app's chat, relayed through Ava Brain (docs/desktop-app.md, D1): the poll, the chat hook.
import { db, threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import { toAppError } from '@extension/shared';
import { DESKTOP_TEXT_MAX } from '@src/shared/lib/protocol/companion';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { createLogger } from '../log';
import { services } from '../registry/services';
import { DEFAULT_DESKTOP_REMOTE_STATE, DesktopBridge } from './bridge';
import type { DesktopRemoteState } from './bridge';

const logger = createLogger('DesktopRemote');

// The window waits on this: a couple of seconds at most before "working" shows
const POLL_MS = 2000;

const stateStorage = createStorage<DesktopRemoteState>('desktop-remote-state', DEFAULT_DESKTOP_REMOTE_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

const getState = async (): Promise<DesktopRemoteState> => ({
  ...DEFAULT_DESKTOP_REMOTE_STATE,
  ...(await stateStorage.get()),
});

export const desktopBridge = new DesktopBridge({
  inbox: async () => (await companionClient.desktopInbox()).messages,
  reply: async ({ chatId, kind, text }) => {
    await companionClient.desktopReply({
      requestId: crypto.randomUUID(),
      chatId,
      kind,
      text: text.slice(0, DESKTOP_TEXT_MAX),
    });
  },
  getThread: id => threadStore.get(id),
  messages: id => threadStore.messages(id),
  startTurn: (threadId, text) => services().threads.send({ threadId, text, origin: 'desktop' }),
  getState,
  updateState: async changes => stateStorage.set({ ...(await getState()), ...changes }),
  warn: (message, error) => logger.warning(message, toAppError(error).kind),
});

async function tick(): Promise<void> {
  if (!(await brainSettingsStore.getSettings()).paired) return;
  await desktopBridge.poll().catch(error => {
    const appError = toAppError(error);
    // Ava Brain closed, or an older Ava Brain without the desktop routes: the next tick tries again
    if (appError.kind !== 'network' && appError.kind !== 'not_found') {
      logger.warning(`Desktop poll failed (${appError.kind})`);
    }
  });
}

setInterval(() => void tick(), POLL_MS);

db.threads.hook('updating', (changes: Partial<ThreadRecord>, _key, before: ThreadRecord) => {
  if (!changes.status || before.origin !== 'desktop') return;
  setTimeout(() => {
    void desktopBridge.onThreadUpdate(before, changes).catch(error => logger.warning('Desktop answer not sent', error));
  });
});
