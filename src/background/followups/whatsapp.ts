import { peopleStore, taskStore } from '@extension/storage';
import { learnFromWhatsapp } from '../people/sources';
import { ownedByOther, ownerNames } from './owner';
import { openChatByName, typeInComposer } from '../whatsapp/page';
import { whatsappSelectors } from '../whatsapp/selectors';
import { findWhatsappTab, probeTab, runInTab } from '../whatsapp/tab';

/**
 * "Draft in WhatsApp" (docs/pm-desk.md, Part 9.3): opens the person's chat in Avi's own WhatsApp Web tab, types the
 * message into its box and stops. It never presses Enter and never clicks Send: Avi reads it there and sends it
 * himself (rule 3). The chat is the person's WhatsApp name when People knows it, else the name Avi uses.
 */

export const MAX_DRAFT = 1000;

/**
 * The text already in the open chat's message box. Runs in the page from its source text, so it uses nothing from
 * outside itself.
 */
export const composerText = (arg: { sel: { composer?: string[] } }): string | null => {
  for (const selector of arg.sel.composer ?? []) {
    try {
      const box = document.querySelector(selector);
      if (box) return (box.textContent || '').replace(/\u00a0/g, ' ').trim();
    } catch {
      // Next selector
    }
  }
  return null;
};

const sameName = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

export async function draftInWhatsapp(taskId: string, text: string): Promise<{ chat: string }> {
  // Every kind of line break is a plain one, which the box takes as a new line, never as Enter
  const message = text
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .trim()
    .slice(0, MAX_DRAFT);
  if (!message) throw new Error('There is no message to type.');
  const task = await taskStore.get(taskId);
  if (!task) throw new Error('That task is no longer on the board.');
  if (task.status !== 'open') throw new Error('That task is closed, so there is nobody to chase.');
  // Only someone People knows: a bare name could open a group or another contact with the same name
  const person = task.ownerId ? await peopleStore.get(task.ownerId) : undefined;
  if (!person) {
    throw new Error(
      'Link this task to a person on the People page first, so the right chat opens. Or copy the message.',
    );
  }
  if (!ownedByOther(task, await ownerNames(), new Map([[person.id, person]]))) {
    throw new Error('That is your own task, so there is nobody to write to.');
  }
  const chat = (person.handles.find(handle => handle.kind === 'whatsapp')?.value || person.name).trim();
  if (!chat) throw new Error('This task has no one to write to.');

  const tab = await findWhatsappTab();
  if (!tab?.id) throw new Error('No WhatsApp Web tab is open. Open web.whatsapp.com and sign in, then try again.');
  const sel = await whatsappSelectors();
  if ((await probeTab(tab.id, sel)).state === 'logged_out') {
    throw new Error('WhatsApp Web is not signed in. Sign in with your phone, then try again.');
  }
  // He sees the chat while the words go in
  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);

  const opened = await runInTab(tab.id, openChatByName, { sel, name: chat });
  if (!opened?.ok) throw new Error(`No WhatsApp chat called "${chat}" was found. Copy the message and paste it there.`);
  // The words go only into the chat that is really open, and only if it is theirs
  const header = (await probeTab(tab.id, sel)).header.trim();
  if (!sameName(header, chat)) {
    throw new Error(`WhatsApp opened "${header || 'another chat'}", not "${chat}", so nothing was typed.`);
  }
  // Words he had started in that chat are his: never cleared
  const before = await runInTab(tab.id, composerText, { sel });
  if (before)
    throw new Error(
      `The message box in "${chat}" already has text in it, so nothing was typed. Copy the message instead.`,
    );
  const typed = await runInTab(tab.id, typeInComposer, { sel, text: message });
  if (!typed?.ok) throw new Error('The message box of that chat was not found. Copy the message instead.');
  void learnFromWhatsapp(chat, task.workspaceId, 'draft').catch(() => undefined);
  return { chat };
}
