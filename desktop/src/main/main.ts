import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron';
import type { AppearanceSettingsConfig } from '@appearance';
import { IPC } from '../shared/ipc';
import type { BrainView } from '../shared/ipc';
import { AppearanceStore } from './appearance-store';
import { BrainClient, BrainError, brainLocation } from './brain';
import { checkText, isChatId } from './validate';

/**
 * The Ava desktop app's main process (docs/desktop-app.md, D1): one window with the Ava chat, Ava Brain's health and
 * the appearance record. The window has no Node and no network of its own: it asks here, through the preload.
 */

const brain = new BrainClient({ location: brainLocation() });
let appearance: AppearanceStore;
let window: BrowserWindow | null = null;

async function brainView(): Promise<BrainView> {
  try {
    const status = await brain.status();
    return {
      state: 'on',
      version: status.version,
      browserOpen: status.browserOpen,
      whatsapp: status.whatsapp,
      queued: status.queued,
    };
  } catch (error) {
    return { state: 'off', message: error instanceof BrainError ? error.message : 'Ava Brain did not answer.' };
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.brainStatus, () => brainView());
  ipcMain.handle(IPC.send, async (_event, chatId: unknown, text: unknown) => {
    if (!isChatId(chatId)) return { ok: false, message: 'Not a conversation of this app.' };
    const words = checkText(text);
    if (!words) return { ok: false, message: 'Nothing to send.' };
    try {
      await brain.send(chatId, words);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Ava Brain did not take it.' };
    }
  });
  ipcMain.handle(IPC.replies, async (_event, after: unknown) => {
    const from = typeof after === 'number' && Number.isInteger(after) && after >= 0 ? after : 0;
    try {
      return await brain.replies(from);
    } catch {
      return { replies: [], restarted: false };
    }
  });
  ipcMain.handle(IPC.startSeq, async () => {
    try {
      return (await brain.status()).lastSeq;
    } catch {
      // Not known yet: the window asks again, rather than reading old answers again from the start
      return null;
    }
  });
  ipcMain.handle(IPC.appearance, () => appearance.get());
  ipcMain.handle(IPC.setAppearance, (_event, changes: unknown) =>
    appearance.update((changes && typeof changes === 'object' ? changes : {}) as Partial<AppearanceSettingsConfig>),
  );
  ipcMain.handle(IPC.systemDark, () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => window?.webContents.send(IPC.systemTheme, nativeTheme.shouldUseDarkColors));
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    title: 'Ava',
    backgroundColor: '#0c0e13',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  window.once('ready-to-show', () => window?.show());
  // The window never goes anywhere else, and opens nothing itself: links go to the default browser
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadFile(join(__dirname, 'renderer', 'index.html'));
}

app.setName('Ava');
app.whenReady().then(() => {
  appearance = new AppearanceStore(join(app.getPath('userData'), 'appearance.json'));
  // No camera, microphone, notifications or anything else for the page until a feature asks for it on purpose
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!window) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
