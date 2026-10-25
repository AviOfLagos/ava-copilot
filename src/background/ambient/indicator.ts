import type { AmbientIndicator } from './manager';

/**
 * Listening is always visible: while ambient listening is on, the toolbar icon carries a dot (filled when Ava is
 * writing down, a hollow ring when off the record). The badge belongs to the Inbox and the tooltip to updates
 * (src/background/inbox/badge.ts, src/background/update/register.ts), so this only ever changes the icon.
 */

const ICON_PATH = 'icon-32.png';
const SIZES = [16, 32] as const;
// Mint like the panel's "on" switches; a muted grey ring off the record
const LISTEN_COLOR = '#3fbf8f';
const OFF_RECORD_COLOR = '#8b93a3';
// On but not hearing (no microphone, no recogniser): a red dot says something is wrong
const ERROR_COLOR = '#d93025';

export type DotStyle = { color: string; hollow: boolean } | null;

/** What the toolbar dot looks like for a state, or null for the plain icon. */
export function dotFor(state: AmbientIndicator): DotStyle {
  if (state.mode === 'off') return null;
  if (state.offRecord) return { color: OFF_RECORD_COLOR, hollow: true };
  if (!state.running) return { color: ERROR_COLOR, hollow: false };
  return { color: LISTEN_COLOR, hollow: false };
}

let base: ImageBitmap | null = null;
let last = '';

async function baseIcon(): Promise<ImageBitmap> {
  if (!base) {
    const blob = await (await fetch(chrome.runtime.getURL(ICON_PATH))).blob();
    base = await createImageBitmap(blob);
  }
  return base;
}

function draw(icon: ImageBitmap, size: number, dot: NonNullable<DotStyle>): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d')!;
  context.drawImage(icon, 0, 0, size, size);
  const radius = size * 0.22;
  const x = size - radius - 0.5;
  const y = size - radius - 0.5;
  // A dark rim keeps the dot readable on any toolbar
  context.beginPath();
  context.arc(x, y, radius + size * 0.06, 0, Math.PI * 2);
  context.fillStyle = '#111418';
  context.fill();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  if (dot.hollow) {
    context.lineWidth = Math.max(1.5, size * 0.09);
    context.strokeStyle = dot.color;
    context.stroke();
  } else {
    context.fillStyle = dot.color;
    context.fill();
  }
  return context.getImageData(0, 0, size, size);
}

/** Shows the state on the toolbar icon. Never fails the caller. */
export async function showIndicator(state: AmbientIndicator): Promise<void> {
  const dot = dotFor(state);
  const key = JSON.stringify(dot);
  if (key === last) return;
  last = key;
  try {
    if (!dot) {
      await chrome.action.setIcon({ path: ICON_PATH });
      return;
    }
    const icon = await baseIcon();
    const imageData = Object.fromEntries(SIZES.map(size => [size, draw(icon, size, dot)]));
    await chrome.action.setIcon({ imageData });
  } catch {
    // An icon that could not be drawn is drawn again on the next change
    last = '';
  }
}
