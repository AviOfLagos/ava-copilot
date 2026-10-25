/*
 * The feature pages' own widgets (components/widgets), as plain scripts over build-time HTML, the same way as the
 * home page's (widgets.ts): each reads as a still picture without JavaScript and plays once when it comes into view.
 * Reduced motion: final states at once.
 */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise<void>(done => window.setTimeout(done, ms));

function onFirstView(root: Element, run: () => void, amount = 0.35) {
  const observer = new IntersectionObserver(
    entries => {
      if (!entries.some(entry => entry.intersectionRatio >= amount)) return;
      observer.disconnect();
      run();
    },
    { threshold: [0, amount] },
  );
  observer.observe(root);
}

// ─── Ambient: lines arrive; off the record stops them; forget removes the latest ──────────────────────────────

function setupAmbient(root: HTMLElement) {
  const lines = Array.from(root.querySelectorAll<HTMLElement>('[data-ambient-line]'));
  const toggle = root.querySelector<HTMLButtonElement>('[data-ambient-switch]');
  const forget = root.querySelector<HTMLButtonElement>('[data-ambient-forget]');
  const replay = root.querySelector<HTMLButtonElement>('[data-ambient-replay]');
  const status = root.querySelector<HTMLElement>('[data-ambient-status]');
  const title = root.querySelector<HTMLElement>('[data-ambient-title]');
  let run = 0;
  let next = 0;

  const offRecord = () => root.hasAttribute('data-off-record');
  const show = (line: HTMLElement, on: boolean) => line.toggleAttribute('data-shown', on);

  const play = async () => {
    const id = ++run;
    if (reduced()) {
      lines.forEach(line => show(line, true));
      next = lines.length;
      return;
    }
    while (next < lines.length) {
      if (id !== run) return;
      if (!offRecord()) {
        show(lines[next], true);
        next++;
      }
      await wait(1500);
    }
    if (replay) replay.hidden = false;
  };

  root.setAttribute('data-playing', '');
  lines.forEach(line => show(line, false));

  toggle?.addEventListener('click', () => {
    const on = !offRecord();
    root.toggleAttribute('data-off-record', on);
    toggle.setAttribute('aria-checked', String(on));
    if (title) title.textContent = (on ? title.dataset.offTitle : title.dataset.onTitle) ?? '';
  });
  forget?.addEventListener('click', () => {
    // The latest three lines, or what is left
    const visible = lines.filter(line => line.hasAttribute('data-shown') && !line.hasAttribute('data-forgotten'));
    visible.slice(-3).forEach(line => line.setAttribute('data-forgotten', ''));
    if (status) status.textContent = visible.length ? (status.dataset.forgot ?? '') : '';
    if (replay) replay.hidden = false;
  });
  replay?.addEventListener('click', () => {
    lines.forEach(line => {
      line.removeAttribute('data-forgotten');
      show(line, false);
    });
    root.removeAttribute('data-off-record');
    toggle?.setAttribute('aria-checked', 'false');
    if (title) title.textContent = title.dataset.onTitle ?? '';
    if (status) status.textContent = '';
    replay.hidden = true;
    next = 0;
    void play();
  });
  onFirstView(root, () => void play());
}

// ─── Meetings: captions arrive, then the note fills ───────────────────────────────────────────────────────────

function setupMeeting(root: HTMLElement) {
  const captions = Array.from(root.querySelectorAll<HTMLElement>('[data-meeting-caption]'));
  const parts = Array.from(root.querySelectorAll<HTMLElement>('[data-meeting-part]'));
  const replay = root.querySelector<HTMLButtonElement>('[data-meeting-replay]');
  const all = [...captions, ...parts];
  let run = 0;

  const play = async () => {
    const id = ++run;
    all.forEach(item => item.removeAttribute('data-shown'));
    root.removeAttribute('data-done');
    if (reduced()) {
      all.forEach(item => item.setAttribute('data-shown', ''));
      root.setAttribute('data-done', '');
      return;
    }
    for (const caption of captions) {
      if (id !== run) return;
      caption.setAttribute('data-shown', '');
      await wait(1100);
    }
    for (const part of parts) {
      if (id !== run) return;
      part.setAttribute('data-shown', '');
      await wait(700);
    }
    root.setAttribute('data-done', '');
    if (replay) replay.hidden = false;
  };

  root.setAttribute('data-playing', '');
  replay?.addEventListener('click', () => {
    replay.hidden = true;
    void play();
  });
  onFirstView(root, () => void play());
}

// ─── Ava Brain: run in the sandbox, then approve ──────────────────────────────────────────────────────────────

function setupBrain(root: HTMLElement) {
  const lines = Array.from(root.querySelectorAll<HTMLElement>('[data-brain-line]'));
  const result = root.querySelector<HTMLElement>('[data-brain-result]');
  const runButton = root.querySelector<HTMLButtonElement>('[data-brain-run]');
  const runLabel = root.querySelector<HTMLElement>('[data-brain-run-label]');
  const approve = root.querySelector<HTMLButtonElement>('[data-brain-approve]');
  const approveLabel = root.querySelector<HTMLElement>('[data-brain-approve-label]');
  if (!runButton || !approve) return;
  const approveText = approveLabel?.textContent ?? '';

  const reset = () => {
    lines.forEach(line => line.removeAttribute('data-shown'));
    result?.removeAttribute('data-shown');
    approve.disabled = true;
    approve.removeAttribute('data-done');
    if (approveLabel) approveLabel.textContent = approveText;
  };
  root.setAttribute('data-playing', '');
  reset();

  runButton.addEventListener('click', async () => {
    reset();
    runButton.disabled = true;
    if (runLabel) runLabel.textContent = runButton.dataset.running ?? '';
    for (const line of lines) {
      line.setAttribute('data-shown', '');
      if (!reduced()) await wait(650);
    }
    result?.setAttribute('data-shown', '');
    runButton.disabled = false;
    if (runLabel) runLabel.textContent = runButton.dataset.label ?? '';
    approve.disabled = false;
  });
  approve.addEventListener('click', () => {
    approve.setAttribute('data-done', '');
    approve.disabled = true;
    if (approveLabel) approveLabel.textContent = approve.dataset.approved ?? '';
  });
}

export function startFeatureWidgets() {
  document.querySelectorAll<HTMLElement>('[data-ambient]').forEach(setupAmbient);
  document.querySelectorAll<HTMLElement>('[data-meeting]').forEach(setupMeeting);
  document.querySelectorAll<HTMLElement>('[data-brain]').forEach(setupBrain);
}
