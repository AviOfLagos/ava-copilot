import { createSttEngine } from './engines';
import type { SttConfig, SttEngine, SttLoadInfo } from './engines';

/**
 * Keeps the last speech model loaded for a few minutes after a conversation ends, so talking again starts at
 * once; after that its worker ends and the memory is freed. A different engine or model replaces it.
 */

export const STT_IDLE_UNLOAD_MS = 5 * 60 * 1000;

let current: { key: string; engine: SttEngine } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let users = 0;
const beside = new Set<SttEngine>();
let lastLoad: (SttLoadInfo & { engine: string }) | null = null;

const keyOf = (config: SttConfig) => `${config.engine}:${config.model ?? ''}:${config.webgpu ? 'gpu' : 'cpu'}`;

/** The engine for this configuration, loaded; release it when done. */
export async function acquireStt(config: SttConfig, create = createSttEngine): Promise<SttEngine> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const key = keyOf(config);
  // An engine in use is never pulled away: another recogniser runs beside it (dictation with Whisper during
  // always-on listening) and ends when released
  if (current && current.key !== key && users > 0) {
    const own = create(config);
    try {
      lastLoad = { ...(await own.load()), engine: key };
    } catch (error) {
      own.dispose();
      throw error;
    }
    beside.add(own);
    return own;
  }
  if (current?.key !== key) {
    current?.engine.dispose();
    current = { key, engine: create(config) };
  }
  users++;
  const engine = current.engine;
  try {
    const info = await engine.load();
    lastLoad = { ...info, engine: key };
  } catch (error) {
    users--;
    if (current?.engine === engine) current = null;
    engine.dispose();
    throw error;
  }
  return engine;
}

export function releaseStt(engine?: SttEngine): void {
  if (engine && beside.delete(engine)) {
    engine.dispose();
    return;
  }
  users = Math.max(0, users - 1);
  if (users > 0 || !current) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unloadStt, STT_IDLE_UNLOAD_MS);
}

/** Frees the speech model now (Settings, or the idle timer). */
export function unloadStt(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (users > 0) return;
  current?.engine.dispose();
  current = null;
}

export function sttStatus(): { loaded: string | null; lastLoad: typeof lastLoad } {
  return { loaded: current?.key ?? null, lastLoad };
}
