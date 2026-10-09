const WAIT_MS = 30_000;

/**
 * Asks the user to allow one action with a click on a notification, for when a spoken order may not
 * be theirs. Nothing but the click allows it: closing it, ignoring it or another button refuses.
 */
export async function allowedByClick(title: string, detail: string): Promise<boolean> {
  const id = `voice-allow-${crypto.randomUUID()}`;
  return new Promise<boolean>(resolve => {
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      void chrome.notifications.clear(id);
      resolve(allowed);
    };
    const onButton = (notificationId: string, button: number) => {
      if (notificationId === id) finish(button === 0);
    };
    const onClosed = (notificationId: string) => {
      if (notificationId === id) finish(false);
    };
    const timer = setTimeout(() => finish(false), WAIT_MS);
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
    chrome.notifications
      .create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-128.png'),
        title,
        message: detail,
        buttons: [{ title: 'Allow' }, { title: 'No' }],
        requireInteraction: true,
        priority: 2,
      })
      .catch(() => finish(false));
  });
}
