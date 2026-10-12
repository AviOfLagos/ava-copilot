/*
 * The site's only page script: the theme switch, copy buttons, the install page's tabs and the one-time reveals of
 * secondary graphics. Everything here is an enhancement; every page reads and works without it.
 */

type ThemeChoice = 'dark' | 'light' | 'system';
const THEME_KEY = 'avi-theme';
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(choice: ThemeChoice) {
  const resolved = choice === 'system' ? (lightQuery.matches ? 'light' : 'dark') : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#f3f4f7' : '#0c0e13');
}

function setupTheme() {
  let choice = storedTheme();
  const groups = document.querySelectorAll<HTMLElement>('[data-theme-toggle]');
  const sync = () => {
    groups.forEach(group => {
      group.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => {
        const on = button.dataset.value === choice;
        button.setAttribute('aria-checked', String(on));
        button.tabIndex = on ? 0 : -1;
      });
    });
  };
  const choose = (next: ThemeChoice, focus?: HTMLButtonElement) => {
    choice = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private windows may refuse storage: the choice still applies to this page
    }
    applyTheme(next);
    sync();
    focus?.focus();
  };
  groups.forEach(group => {
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => choose(button.dataset.value as ThemeChoice));
      button.addEventListener('keydown', event => {
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? -1
              : 0;
        if (!step) return;
        event.preventDefault();
        const next = buttons[(index + step + buttons.length) % buttons.length];
        choose(next.dataset.value as ThemeChoice, next);
      });
    });
  });
  lightQuery.addEventListener('change', () => {
    if (choice === 'system') applyTheme('system');
  });
  sync();
}

// One polite region for short confirmations, such as "copied"
let announcer: HTMLElement | null = null;
function announce(text: string) {
  if (!announcer) {
    announcer = document.createElement('p');
    announcer.className = 'sr-only';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.append(announcer);
  }
  announcer.textContent = '';
  window.setTimeout(() => {
    if (announcer) announcer.textContent = text;
  }, 60);
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers or an insecure origin: copy through a selection instead
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function setupCopy() {
  document.addEventListener('click', async event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-copy]');
    if (!button) return;
    const ok = await writeClipboard(button.dataset.copy ?? '');
    if (!ok) {
      announce(button.dataset.failed ?? '');
      return;
    }
    button.setAttribute('data-copied', '');
    announce(button.dataset.announce ?? '');
    window.clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = String(window.setTimeout(() => button.removeAttribute('data-copied'), 1800));
  });
}

function detectSystem(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
  if (/win/i.test(platform)) return 'windows';
  if (/linux|x11/i.test(platform) && !/android/i.test(platform)) return 'linux';
  return 'macos';
}

function setupTabs() {
  document.querySelectorAll<HTMLElement>('[data-tabs]').forEach(root => {
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls') ?? ''));
    // Panels are plain sections without scripts; with them they become the tabs' panels
    panels.forEach(panel => {
      panel?.setAttribute('role', 'tabpanel');
      panel?.setAttribute('tabindex', '0');
    });
    const select = (index: number, focus = false) => {
      tabs.forEach((tab, at) => {
        const on = at === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[at]?.toggleAttribute('hidden', !on);
      });
      if (focus) tabs[index]?.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(index));
      tab.addEventListener('keydown', event => {
        const last = tabs.length - 1;
        const next =
          event.key === 'ArrowRight'
            ? index === last
              ? 0
              : index + 1
            : event.key === 'ArrowLeft'
              ? index === 0
                ? last
                : index - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? last
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        select(next, true);
      });
    });
    // A link such as /install#windows picks that tab; otherwise the visitor's own system
    const fromHash = tabs.findIndex(tab => tab.dataset.os && `#${tab.dataset.os}` === window.location.hash);
    const fromSystem = tabs.findIndex(tab => tab.dataset.os === detectSystem());
    select(fromHash >= 0 ? fromHash : Math.max(0, fromSystem));
    root.setAttribute('data-ready', '');
    if (fromHash >= 0) root.scrollIntoView({ block: 'start' });
  });
}

function setupReveal() {
  const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach(target => target.setAttribute('data-shown', ''));
    return;
  }
  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.setAttribute('data-shown', '');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.2 },
  );
  targets.forEach(target => observer.observe(target));
}

setupTheme();
setupCopy();
setupTabs();
setupReveal();
