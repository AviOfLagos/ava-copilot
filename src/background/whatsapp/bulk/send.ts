import type { BulkRecipient } from '@extension/storage';
import { clickSend, sendAttachment, typeInComposer } from '../page';
import type { WhatsappSelectors } from '../selectors';
import { probeTab, runInTab, waitForState } from '../tab';
import type { SendOutcome } from './runner';

/**
 * Sends one approved bulk message from the user's WhatsApp Web tab: opens the number with WhatsApp's own send
 * link (works for numbers not in the contacts), checks the box holds exactly the approved text, clicks send and
 * waits to see the message in the chat. A number WhatsApp calls invalid is skipped. After the click, an unseen
 * message is an unknown outcome, never a retry.
 */

// WhatsApp Web reloads on a send link; a slow connection takes a while
const OPEN_TIMEOUT_MS = 45_000;
const CONFIRM_TIMEOUT_MS = 12_000;

const squash = (text: string) => text.replace(/\s+/g, '');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface AttachmentData {
  name: string;
  type: string;
  base64: string;
}

async function tabExists(tabId: number): Promise<boolean> {
  return chrome.tabs
    .get(tabId)
    .then(tab => Boolean(tab))
    .catch(() => false);
}

export async function sendToRecipient(
  tabId: number,
  recipient: BulkRecipient,
  sel: WhatsappSelectors,
  attachment: AttachmentData | null,
  signal: AbortSignal,
): Promise<SendOutcome> {
  const text = attachment ? '' : `&text=${encodeURIComponent(recipient.message)}`;
  try {
    await chrome.tabs.update(tabId, { url: `https://web.whatsapp.com/send?phone=${recipient.phone}${text}` });
  } catch {
    return { status: 'pending', reason: 'tab_closed' };
  }
  await sleep(600);
  const probe = await waitForState(tabId, sel, ['chat_open', 'invalid_number', 'logged_out'], OPEN_TIMEOUT_MS, signal);
  if (probe.state === 'logged_out') return { status: 'pending', reason: 'logged_out' };
  if (probe.state === 'invalid_number') return { status: 'skipped', reason: 'not_on_whatsapp' };
  if (probe.state !== 'chat_open') {
    if (!(await tabExists(tabId))) return { status: 'pending', reason: 'tab_closed' };
    return { status: 'failed', reason: 'not_loaded' };
  }
  if (signal.aborted) return { status: 'failed', reason: 'stopped' };

  const before = probe.outgoing;
  if (attachment) {
    const sent = await runInTab(
      tabId,
      sendAttachment,
      { sel, ...attachment, caption: recipient.message },
      'MAIN',
    ).catch(() => false);
    if (!sent) return { status: 'failed', reason: 'send_failed' };
  } else {
    if (squash(probe.composerText) !== squash(recipient.message)) {
      const typed = await runInTab(tabId, typeInComposer, { sel, text: recipient.message });
      if (!typed?.ok || squash(typed.text) !== squash(recipient.message))
        return { status: 'failed', reason: 'send_failed' };
    }
    const clicked = await runInTab(tabId, clickSend, { sel }).catch(() => false);
    if (!clicked) return { status: 'failed', reason: 'send_failed' };
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const now = await probeTab(tabId, sel);
    if (now.outgoing > before) return { status: 'sent' };
    await sleep(300);
  }
  return { status: 'failed', reason: 'unknown_outcome' };
}
