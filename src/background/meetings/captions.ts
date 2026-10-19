/**
 * Reading a call's own live captions from the page, keeping them on, and noticing when the user leaves.
 *
 * Every selector and label lives in `CALL_DOM` (one place to fix when Meet changes its page), and the
 * functions below receive it as an argument: they run inside the meeting page from their source text, so
 * each must be self-contained (no imports, no helpers from this file, no outer variables).
 *
 * Google Meet's page is not documented. What is known (2025–2026, from Meet's own accessibility markup):
 * the captions sit in a `role="region"` labelled "Captions" in the UI language; each speaker turn is a
 * block holding the speaker's name and the words, which grow and get revised as they are spoken; the
 * captions and leave buttons carry Material Symbols icons whose ligature text (`closed_caption_off`,
 * `closed_caption`, `call_end`) does not change with the language. Accessible names and icon names are
 * used first, class names only as a last resort.
 */

export interface CallDom {
  // The captions container, matched by its accessible name in any of these languages (regex source)
  regionNames: string;
  // More ways to find the container, tried in order after the accessible name
  regionSelectors: string[];
  // One speaker's turn inside the container
  blockSelectors: string[];
  speakerSelectors: string[];
  textSelectors: string[];
  // Pages that show one element per caption line (Zoom web, Teams), read when no container is found
  lineSelectors: string[];
  // Icon ligatures of the captions button while captions are off, and while they are on
  captionsOffIcons: string[];
  captionsOnIcons: string[];
  // Accessible names of the captions button (regex sources, any language)
  turnOnNames: string;
  turnOffNames: string;
  // The leave button: its icon, its accessible names, and ids some platforms use
  leaveIcons: string[];
  leaveNames: string;
  leaveSelectors: string[];
  // Buttons that only show once the user has left (Meet's "You left the meeting" screen)
  leftNames: string;
}

export const CALL_DOM: CallDom = {
  regionNames: '^(captions|legendas|subt[ií]tulos|sous-titres|untertitel|sottotitoli|ondertiteling|napisy|字幕|자막)$',
  regionSelectors: ['.a4cQT', '[jsname="dsyhDe"]'],
  blockSelectors: ['.nMcdL', '.TBMuR', '[data-speaker]', '[data-participant-id]'],
  speakerSelectors: ['.NWpY1d', '.KcIKyf', '.zs7s8d', '[data-self-name]'],
  textSelectors: ['.ygicle', '.bh44bd', '.iTTPOb', '[jsname="tgaKEf"]'],
  lineSelectors: ['div[jsname="tgaKEf"]', '.live-transcription-subtitle__item', '[data-tid="closed-caption-text"]'],
  captionsOffIcons: ['closed_caption_off'],
  captionsOnIcons: ['closed_caption'],
  turnOnNames:
    'turn on captions|show captions|ativar legendas|mostrar legendas|activar subt[ií]tulos|activer les sous-titres|untertitel aktivieren|attiva sottotitoli|开启字幕|開啟字幕|字幕を有効|자막 사용',
  turnOffNames:
    'turn off captions|hide captions|desativar legendas|ocultar legendas|desactivar subt[ií]tulos|d[ée]sactiver les sous-titres|untertitel deaktivieren|disattiva sottotitoli|关闭字幕|關閉字幕|字幕を無効|자막 사용 중지',
  leaveIcons: ['call_end'],
  leaveNames:
    'leave (call|meeting)|end call|hang up|sair da (chamada|reuni[ãa]o)|salir de la (llamada|reuni[óo]n)|quitter l.appel|anruf verlassen|abbandona la chiamata|退出通话|退出通話|離開通話|退出會議|通話から退出|통화에서 나가기',
  leaveSelectors: ['#hangup-button', '[data-tid="hangup-main-btn"]'],
  leftNames:
    '^(rejoin|return to home screen|participar novamente|voltar para a tela inicial|volver a unirse|rejoindre|erneut teilnehmen|重新加入|返回主畫面|返回主屏幕)$',
};

// Kept for pages other than calls that show captions (any of the line or block selectors)
export const CAPTION_SELECTORS = [...CALL_DOM.lineSelectors, '[aria-label="Captions"]'];

export interface CallState {
  // The user is in the call: its Leave button is there
  inCall: boolean;
  // The page shows the "you left" screen
  left: boolean;
  // Whether the call shows captions: true or false from its captions button, null when no button was found
  captionsOn: boolean | null;
  // A captions container or caption line is on the page
  captionsShown: boolean;
  // This page is reading captions (or watching the call) for this meeting
  watching: boolean;
}

/** Runs in the meeting page: where the call stands. */
export function readCallState(dom: CallDom, meetingId: string | null = null): CallState {
  const nameOf = (element: Element) =>
    `${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-tooltip') || ''}`.trim();
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const iconOf = (button: Element) =>
    Array.from(button.querySelectorAll('i, span, [aria-hidden="true"]'))
      .map(icon => (icon.children.length === 0 ? (icon.textContent || '').trim() : ''))
      .filter(Boolean);
  const hasIcon = (names: string[]) => buttons.some(button => iconOf(button).some(icon => names.includes(icon)));
  const named = (source: string) => {
    const pattern = new RegExp(source, 'i');
    return buttons.some(button => pattern.test(nameOf(button)));
  };
  const textNamed = (source: string) => {
    const pattern = new RegExp(source, 'i');
    return buttons.some(button => pattern.test(((button as HTMLElement).innerText || button.textContent || '').trim()));
  };

  const inCall =
    !!document.querySelector(dom.leaveSelectors.join(',')) || hasIcon(dom.leaveIcons) || named(dom.leaveNames);
  const left = !inCall && (textNamed(dom.leftNames) || named(dom.leftNames));
  let captionsOn: boolean | null = null;
  if (named(dom.turnOffNames) || hasIcon(dom.captionsOnIcons)) captionsOn = true;
  else if (named(dom.turnOnNames) || hasIcon(dom.captionsOffIcons)) captionsOn = false;

  const regionPattern = new RegExp(dom.regionNames, 'i');
  const region =
    Array.from(document.querySelectorAll('[aria-label]')).some(
      element =>
        !element.matches('button, [role="button"], [role="menuitem"], [role="tab"], [role="option"]') &&
        regionPattern.test((element.getAttribute('aria-label') || '').trim()),
    ) || !!document.querySelector(dom.regionSelectors.join(','));
  const captionsShown = region || !!document.querySelector(dom.lineSelectors.join(','));
  // The region showing means captions are on, whatever the button says
  if (region && captionsOn === null) captionsOn = true;

  const holder = window as unknown as { __aviCaptions?: { meetingId: string } };
  const watching = !!holder.__aviCaptions && (meetingId === null || holder.__aviCaptions.meetingId === meetingId);
  return { inCall, left, captionsOn, captionsShown, watching };
}

/**
 * Runs in a Google Meet page: turns its captions on, through the captions button (found by its icon or
 * its name in the UI language), else Meet's own "c" shortcut.
 *
 * @returns 'on' when they already were, 'clicked' when it pressed the button, 'key' when it used the
 *   shortcut, 'missing' when it found no way to
 */
export function turnOnCaptions(dom: CallDom): 'on' | 'clicked' | 'key' | 'missing' {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
  const nameOf = (element: Element) =>
    `${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-tooltip') || ''}`.trim();
  const iconOf = (button: Element) =>
    Array.from(button.querySelectorAll('i, span, [aria-hidden="true"]'))
      .map(icon => (icon.children.length === 0 ? (icon.textContent || '').trim() : ''))
      .filter(Boolean);
  const off = new RegExp(dom.turnOffNames, 'i');
  const on = new RegExp(dom.turnOnNames, 'i');
  if (
    buttons.some(button => off.test(nameOf(button))) ||
    buttons.some(button => iconOf(button).some(icon => dom.captionsOnIcons.includes(icon)))
  ) {
    return 'on';
  }
  const button =
    buttons.find(candidate => on.test(nameOf(candidate))) ??
    buttons.find(candidate => iconOf(candidate).some(icon => dom.captionsOffIcons.includes(icon)));
  if (button) {
    button.click();
    return 'clicked';
  }
  // Meet's shortcut for captions; only when the call is focused and no text field is
  const active = document.activeElement;
  if (active && active.matches('input, textarea, [contenteditable="true"]')) return 'missing';
  for (const type of ['keydown', 'keyup']) {
    document.body.dispatchEvent(new KeyboardEvent(type, { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true }));
  }
  return 'key';
}

/** The words of `text` that were not sent yet, when `sent` was an earlier reading of the same caption. */
export function captionDelta(sent: string, text: string): string {
  if (!sent) return text;
  if (text === sent) return '';
  if (text.startsWith(sent)) return text.slice(sent.length).trim();
  // The caption dropped its oldest words or revised its last ones: continue after the last words sent
  const sentWords = sent.split(' ');
  for (let n = Math.min(8, sentWords.length); n >= 3; n--) {
    const tail = sentWords.slice(-n).join(' ');
    const at = text.lastIndexOf(tail);
    if (at >= 0) return text.slice(at + tail.length).trim();
  }
  return text;
}

/**
 * Runs in the meeting page. With `readCaptions`, reports each caption once it stops changing (and a long
 * one in parts as it grows); always reports once when the user leaves the call (its Leave button gone for
 * ~12 s after being there, or the "you left" screen), so notes end right away.
 */
export function watchCaptions(meetingId: string, dom: CallDom, readCaptions = true): boolean {
  type Watch = { stop: () => void; meetingId: string };
  const holder = window as unknown as { __aviCaptions?: Watch };
  holder.__aviCaptions?.stop();

  const SETTLE_MS = 1500;
  // A caption still growing after this long is sent up to its last few words, which may yet change
  const PART_MS = 8000;
  const PART_CHARS = 40;
  const send = (message: Record<string, unknown>) =>
    chrome.runtime.sendMessage({ ...message, meetingId }).catch(() => {});
  const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
  // Same as captionDelta in captions.ts (a unit test keeps them identical)
  const delta = (sent: string, text: string): string => {
    if (!sent) return text;
    if (text === sent) return '';
    if (text.startsWith(sent)) return text.slice(sent.length).trim();
    // The caption dropped its oldest words or revised its last ones: continue after the last words sent
    const sentWords = sent.split(' ');
    for (let n = Math.min(8, sentWords.length); n >= 3; n--) {
      const tail = sentWords.slice(-n).join(' ');
      const at = text.lastIndexOf(tail);
      if (at >= 0) return text.slice(at + tail.length).trim();
    }
    return text;
  };
  const regionPattern = new RegExp(dom.regionNames, 'i');

  const findRegion = (): Element | null => {
    const named = Array.from(document.querySelectorAll('[aria-label]')).filter(
      element =>
        !element.matches('button, [role="button"], [role="menuitem"], [role="tab"], [role="option"]') &&
        regionPattern.test((element.getAttribute('aria-label') || '').trim()),
    );
    // A live region is the captions themselves; anything else with the name is a fallback
    return (
      named.find(element => element.getAttribute('role') === 'region') ??
      named[0] ??
      document.querySelector(dom.regionSelectors.join(','))
    );
  };

  // Each caption on the page right now: its element, who speaks, and the words
  const readBlocks = (): { element: Element; speaker: string; text: string }[] => {
    const region = findRegion();
    if (region) {
      let blocks = Array.from(region.querySelectorAll(dom.blockSelectors.join(',')));
      // Keep the outermost block only, so nested matches are not read twice
      blocks = blocks.filter(block => !blocks.some(other => other !== block && other.contains(block)));
      if (blocks.length === 0) {
        // Unknown inner markup: each child of the innermost wrapper is a turn
        let wrapper: Element = region;
        while (wrapper.children.length === 1 && wrapper.firstElementChild) wrapper = wrapper.firstElementChild;
        blocks = Array.from(wrapper.children);
      }
      return blocks.map(block => {
        const speakerElement = block.querySelector(dom.speakerSelectors.join(','));
        let speaker = clean(block.getAttribute('data-speaker')) || clean(speakerElement?.textContent);
        const textElement = block.querySelector(dom.textSelectors.join(','));
        let text = clean(textElement?.textContent);
        if (!text) {
          const parts = Array.from(block.children);
          if (!speaker && parts.length >= 2) speaker = clean(parts[0].textContent);
          text = clean(block.textContent);
          if (speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
        }
        return { element: block, speaker, text };
      });
    }
    return Array.from(document.querySelectorAll(dom.lineSelectors.join(','))).map(element => {
      const named = element.closest('[data-speaker], [data-tid="closed-caption-message"]');
      const speaker =
        clean(named?.getAttribute('data-speaker')) || clean(named?.querySelector('[data-tid="author"]')?.textContent);
      return { element, speaker, text: clean(element.textContent) };
    });
  };

  const seen = new Map<Element, { speaker: string; text: string; sent: string; changedAt: number; sentAt: number }>();
  const captionTimer = readCaptions
    ? setInterval(() => {
        const now = Date.now();
        const lines: { speaker: string; text: string }[] = [];
        const current = new Set<Element>();
        for (const { element, speaker, text } of readBlocks()) {
          current.add(element);
          const entry = seen.get(element) ?? { speaker, text: '', sent: '', changedAt: now, sentAt: now };
          if (speaker) entry.speaker = speaker;
          if (text !== entry.text) {
            entry.text = text;
            entry.changedAt = now;
            if (now - entry.sentAt >= PART_MS && text.length - entry.sent.length >= PART_CHARS) {
              // Long speech: send what is settled, keeping the last three words for later
              const settled = text.split(' ').slice(0, -3).join(' ');
              const fresh = delta(entry.sent, settled);
              if (fresh) lines.push({ speaker: entry.speaker, text: fresh });
              entry.sent = settled;
              entry.sentAt = now;
            }
          } else if (text && text !== entry.sent && now - entry.changedAt >= SETTLE_MS) {
            const fresh = delta(entry.sent, text);
            if (fresh) lines.push({ speaker: entry.speaker, text: fresh });
            entry.sent = text;
            entry.sentAt = now;
          }
          seen.set(element, entry);
        }
        // A caption that left the page before it settled still counts
        for (const [element, entry] of seen) {
          if (current.has(element)) continue;
          const fresh = entry.text !== entry.sent ? delta(entry.sent, entry.text) : '';
          if (fresh) lines.push({ speaker: entry.speaker, text: fresh });
          seen.delete(element);
        }
        if (lines.length > 0) send({ type: 'meeting_captions', lines });
      }, 500)
    : null;

  // Leaving: the Leave button was there and has gone, or Meet shows its "you left" screen
  const leavePattern = new RegExp(dom.leaveNames, 'i');
  const leftPattern = new RegExp(dom.leftNames, 'i');
  let wasInCall = false;
  let missing = 0;
  let reported = false;
  const callTimer = setInterval(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const inCall =
      !!document.querySelector(dom.leaveSelectors.join(',')) ||
      buttons.some(button => leavePattern.test(button.getAttribute('aria-label') || '')) ||
      buttons.some(button =>
        Array.from(button.querySelectorAll('i, span')).some(icon =>
          dom.leaveIcons.includes((icon.textContent || '').trim()),
        ),
      );
    const left = !inCall && buttons.some(button => leftPattern.test(((button as HTMLElement).innerText || '').trim()));
    if (inCall) {
      wasInCall = true;
      missing = 0;
      return;
    }
    missing += 1;
    if (!reported && (left || (wasInCall && missing >= 6))) {
      reported = true;
      send({ type: 'meeting_call_left' });
    }
  }, 2000);

  holder.__aviCaptions = {
    meetingId,
    stop: () => {
      if (captionTimer) clearInterval(captionTimer);
      clearInterval(callTimer);
    },
  };
  return true;
}

/** Runs in the meeting page: stops watching captions and the call. */
export function stopWatchingCaptions(): boolean {
  const holder = window as unknown as { __aviCaptions?: { stop: () => void } };
  holder.__aviCaptions?.stop();
  delete holder.__aviCaptions;
  return true;
}

/** Runs in the meeting page: whether it shows captions right now. */
export function pageHasCaptions(selectors: string[]): boolean {
  return document.querySelector(selectors.join(',')) !== null;
}
