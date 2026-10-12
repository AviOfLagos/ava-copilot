/*
 * The home page's small widgets, as plain scripts over build-time HTML (no framework): each one reads and works as
 * a still picture without JavaScript, and plays once when it comes into view. Reduced motion: final states at once.
 */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise<void>(done => window.setTimeout(done, ms));

/** Calls `run` once, when `root` is at least `amount` in view. */
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

// ─── 02: the run trail, with the sign-in handed back ────────────────────────────────────────────────────────────

function setupTrail(root: HTMLElement) {
  const steps = Array.from(root.querySelectorAll<HTMLElement>('[data-step]'));
  const handback = root.querySelector<HTMLElement>('[data-handback]');
  const signedIn = root.querySelector<HTMLElement>('[data-signed-in]');
  const held = root.querySelector<HTMLElement>('[data-held]');
  const working = root.querySelector<HTMLElement>('[data-working]');
  const stopped = root.querySelector<HTMLElement>('[data-stopped]');
  const count = root.querySelector<HTMLElement>('[data-count]');
  const status = root.querySelector<HTMLElement>('[data-status-text]');
  const continueButton = root.querySelector<HTMLButtonElement>('[data-continue]');
  // The composer-style Stop and the card's own Stop
  const stopButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-stop]'));
  const replayButton = root.querySelector<HTMLButtonElement>('[data-replay]');
  const countText = count?.dataset.template ?? '{count}';
  let run = 0;
  let resume: (() => void) | null = null;

  const shown = (element: Element | null, on: boolean) => element?.toggleAttribute('data-on', on);
  const tally = () => {
    const done = root.querySelectorAll('[data-on][data-counts]').length;
    if (count) count.textContent = countText.replace('{count}', String(done));
  };
  const setState = (state: string, text?: string) => {
    root.dataset.state = state;
    if (status && text !== undefined) status.textContent = text;
  };

  const reset = () => {
    steps.forEach(step => shown(step, false));
    [handback, signedIn, held, stopped].forEach(element => shown(element, false));
    shown(working, false);
    tally();
  };

  const play = async () => {
    const id = ++run;
    resume = null;
    reset();
    setState('running', '');
    const alive = () => id === run;
    shown(working, true);
    await wait(700);
    if (!alive()) return;
    shown(steps[0], true);
    tally();
    await wait(700);
    if (!alive()) return;
    // Its turn is over: the page needs your sign-in
    shown(working, false);
    shown(handback, true);
    setState('handback', handback?.dataset.say ?? '');
    await new Promise<void>(done => (resume = done));
    if (!alive()) return;
    shown(handback, false);
    shown(signedIn, true);
    shown(working, true);
    setState('running', '');
    tally();
    for (const step of steps.slice(1)) {
      await wait(760);
      if (!alive()) return;
      shown(step, true);
      tally();
    }
    await wait(640);
    if (!alive()) return;
    shown(working, false);
    shown(held, true);
    setState('held', held?.dataset.say ?? '');
    tally();
  };

  continueButton?.addEventListener('click', () => {
    const next = resume;
    resume = null;
    next?.();
    // The card goes; the focus stays on the run's own Stop
    stopButtons[stopButtons.length - 1]?.focus({ preventScroll: true });
  });
  const stop = () => {
    if (root.dataset.state === 'held' || root.dataset.state === 'stopped') return;
    run++;
    resume = null;
    shown(working, false);
    shown(handback, false);
    shown(stopped, true);
    setState('stopped', stopped?.dataset.say ?? '');
    tally();
    replayButton?.focus({ preventScroll: true });
  };
  stopButtons.forEach(button => button.addEventListener('click', stop));
  replayButton?.addEventListener('click', () => void play());

  if (reduced()) {
    // The whole run at once: signed in, filled, waiting at Submit
    steps.forEach(step => shown(step, true));
    shown(signedIn, true);
    shown(held, true);
    setState('held');
    tally();
    return;
  }
  reset();
  setState('ready', '');
  onFirstView(root, () => void play(), 0.45);
}

// ─── 04: the graph you can point at ─────────────────────────────────────────────────────────────────────────────

function setupGraph(root: HTMLElement) {
  const svg = root.querySelector<SVGElement>('svg');
  const detail = root.querySelector<HTMLElement>('[data-graph-detail]');
  const nodes = Array.from(root.querySelectorAll<SVGGElement>('[data-node]'));
  if (!svg || !detail) return;
  const fallback = Array.from(detail.childNodes, child => child.cloneNode(true));
  const focus = (node: SVGGElement | null) => {
    if (!node) {
      svg.removeAttribute('data-focus');
      nodes.forEach(item => item.removeAttribute('data-near'));
      root.querySelectorAll('[data-edge]').forEach(edge => edge.removeAttribute('data-near'));
      detail.replaceChildren(...fallback.map(child => child.cloneNode(true)));
      return;
    }
    const key = node.dataset.node ?? '';
    svg.setAttribute('data-focus', key);
    const near = new Set([key]);
    root.querySelectorAll<SVGPathElement>('[data-edge]').forEach(edge => {
      const ends = (edge.dataset.edge ?? '').split(' ');
      const touches = ends.includes(key);
      edge.toggleAttribute('data-near', touches);
      if (touches) ends.forEach(end => near.add(end));
    });
    nodes.forEach(item => item.toggleAttribute('data-near', near.has(item.dataset.node ?? '')));
    const kind = node.dataset.kind ?? '';
    const label = node.dataset.label ?? '';
    const head = document.createElement('b');
    head.textContent = `${kind} · ${label}`;
    const text = document.createElement('span');
    text.textContent = node.dataset.detail ?? '';
    detail.replaceChildren(head, text);
  };
  nodes.forEach(node => {
    node.addEventListener('pointerenter', () => focus(node));
    node.addEventListener('focus', () => focus(node));
    node.addEventListener('pointerleave', () => focus(null));
    node.addEventListener('blur', () => focus(null));
  });
}

// ─── 05: the routine, lighting node by node ─────────────────────────────────────────────────────────────────────

function setupRoutine(root: HTMLElement) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flow-node]'));
  const wires = Array.from(root.querySelectorAll<HTMLElement>('[data-wire]'));
  const button = root.querySelector<HTMLButtonElement>('[data-run]');
  const labels = JSON.parse(root.dataset.labels ?? '{}') as Record<string, string>;
  let run = 0;

  const set = (node: HTMLElement, status: string) => {
    node.dataset.status = status;
    const mark = node.querySelector<HTMLElement>('[data-mark]');
    if (mark) mark.setAttribute('aria-label', labels[status] ?? status);
  };

  const play = async () => {
    const id = ++run;
    root.dataset.state = 'running';
    if (button) button.disabled = true;
    nodes.forEach(node => set(node, 'queued'));
    wires.forEach(wire => (wire.dataset.status = 'idle'));
    for (const [index, node] of nodes.entries()) {
      await wait(index === 0 ? 300 : 260);
      if (id !== run) return;
      const isHeld = node.hasAttribute('data-held');
      set(node, isHeld ? 'waiting' : 'running');
      const into = wires[index - 1];
      if (into) into.dataset.status = isHeld ? 'held' : 'active';
      if (isHeld) break;
      await wait(620);
      if (id !== run) return;
      set(node, 'succeeded');
      if (into) into.dataset.status = 'done';
    }
    root.dataset.state = 'waiting';
    if (button) button.disabled = false;
  };

  button?.addEventListener('click', () => void play());
  if (reduced()) return;
  onFirstView(root, () => void play(), 0.4);
}

// ─── 05: the Inbox, one approval at a time ──────────────────────────────────────────────────────────────────────

function setupInbox(root: HTMLElement) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-card]'));
  const result = root.querySelector<HTMLElement>('[data-result]');
  const empty = root.querySelector<HTMLElement>('[data-empty]');
  const reset = root.querySelector<HTMLButtonElement>('[data-reset]');
  // After an answer the focus moves to the next card (or "Show them again"); on load it stays where it is
  const order = (moveFocus = false) => {
    const left = cards.filter(card => !card.hasAttribute('data-gone'));
    left.forEach((card, index) => {
      card.style.setProperty('--depth', String(index));
      card.toggleAttribute('inert', index > 0);
    });
    root.toggleAttribute('data-empty', left.length === 0);
    if (!moveFocus) return;
    if (left.length === 0) empty?.querySelector('button')?.focus({ preventScroll: true });
    else left[0]?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  };
  cards.forEach(card => {
    card.querySelectorAll<HTMLButtonElement>('[data-answer]').forEach(button =>
      button.addEventListener('click', () => {
        const answer = button.dataset.answer ?? 'done';
        card.dataset.gone = answer;
        const said = { approve: root.dataset.approved, decline: root.dataset.declined, done: root.dataset.done };
        if (result) result.textContent = said[answer as keyof typeof said] ?? '';
        window.setTimeout(() => order(true), reduced() ? 0 : 60);
      }),
    );
  });
  reset?.addEventListener('click', () => {
    cards.forEach(card => card.removeAttribute('data-gone'));
    if (result) result.textContent = '';
    order(true);
  });
  order();
}

// ─── 06: the model picker ───────────────────────────────────────────────────────────────────────────────────────

function setupModels(root: HTMLElement) {
  const route = root.querySelector<HTMLElement>('[data-route]');
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  if (!route) return;
  const show = (input: HTMLInputElement) => {
    route.dataset.kind = input.dataset.kind ?? '';
    route.querySelectorAll<HTMLElement>('[data-fill]').forEach(slot => {
      slot.textContent = input.dataset[slot.dataset.fill ?? ''] ?? '';
    });
  };
  inputs.forEach(input => input.addEventListener('change', () => input.checked && show(input)));
  const checked = inputs.find(input => input.checked);
  if (checked) show(checked);
}

// ─── The task list, with a preview that follows the pointer ─────────────────────────────────────────────────────

function setupTasks(root: HTMLElement) {
  const preview = root.querySelector<HTMLElement>('[data-preview]');
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-task]'));
  if (!preview) return;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  let x = 0;
  let y = 0;
  let px = 0;
  let py = 0;
  let vx = 0;
  let vy = 0;
  let frame = 0;
  let last = 0;

  const fill = (row: HTMLElement) => {
    const template = root.querySelector<HTMLTemplateElement>(`template[data-for="${row.dataset.task}"]`);
    if (!template) return;
    preview.replaceChildren(template.content.cloneNode(true));
  };
  const tick = (now: number) => {
    frame = 0;
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;
    // A spring with a little lag: the lag is the effect
    const stiffness = 170;
    const damping = 22;
    vx += (stiffness * (x - px) - damping * vx) * dt;
    vy += (stiffness * (y - py) - damping * vy) * dt;
    px += vx * dt;
    py += vy * dt;
    preview.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
    if (Math.abs(x - px) + Math.abs(y - py) + Math.abs(vx) + Math.abs(vy) > 0.5) frame = requestAnimationFrame(tick);
  };
  const move = (event: PointerEvent) => {
    const box = root.getBoundingClientRect();
    x = event.clientX - box.left + 28;
    y = event.clientY - box.top - 110;
    if (reduced()) {
      px = x;
      py = y;
      preview.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      return;
    }
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  rows.forEach(row => {
    row.addEventListener('pointerenter', event => {
      if (!fine.matches) return;
      fill(row);
      if (!root.hasAttribute('data-previewing')) {
        const box = root.getBoundingClientRect();
        px = x = event.clientX - box.left + 28;
        py = y = event.clientY - box.top - 110;
        preview.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      }
      root.setAttribute('data-previewing', '');
    });
    // Keyboard: the preview sits beside the focused row
    row.addEventListener('focus', () => {
      fill(row);
      const box = root.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      px = x = rowBox.right - box.left - 340;
      py = y = rowBox.top - box.top - 40;
      preview.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      root.setAttribute('data-previewing', '');
    });
    row.addEventListener('blur', () => root.removeAttribute('data-previewing'));
  });
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', () => root.removeAttribute('data-previewing'));
}

export function startWidgets() {
  document.querySelectorAll<HTMLElement>('[data-trail-run]').forEach(setupTrail);
  document.querySelectorAll<HTMLElement>('[data-graph]').forEach(setupGraph);
  document.querySelectorAll<HTMLElement>('[data-routine]').forEach(setupRoutine);
  document.querySelectorAll<HTMLElement>('[data-inbox]').forEach(setupInbox);
  document.querySelectorAll<HTMLElement>('[data-models]').forEach(setupModels);
  document.querySelectorAll<HTMLElement>('[data-tasks]').forEach(setupTasks);
}
