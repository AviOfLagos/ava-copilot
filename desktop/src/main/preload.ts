import { contextBridge, ipcRenderer } from 'electron';
import type { AvaBridge } from '../shared/ipc';
import { IPC } from '../shared/ipc';

// The whole of what the window can reach: these calls, nothing of Node or Electron itself
const bridge: AvaBridge = {
  brainStatus: () => ipcRenderer.invoke(IPC.brainStatus),
  send: (chatId, text) => ipcRenderer.invoke(IPC.send, chatId, text),
  replies: after => ipcRenderer.invoke(IPC.replies, after),
  startSeq: () => ipcRenderer.invoke(IPC.startSeq),
  appearance: () => ipcRenderer.invoke(IPC.appearance),
  setAppearance: changes => ipcRenderer.invoke(IPC.setAppearance, changes),
  systemDark: () => ipcRenderer.invoke(IPC.systemDark),
  onSystemTheme: listener => {
    const handler = (_event: unknown, dark: boolean) => listener(dark);
    ipcRenderer.on(IPC.systemTheme, handler);
    return () => ipcRenderer.removeListener(IPC.systemTheme, handler);
  },
};

contextBridge.exposeInMainWorld('ava', bridge);
