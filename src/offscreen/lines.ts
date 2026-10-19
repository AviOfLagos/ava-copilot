import type { EconomyEngines } from '../background/voice/engines/wire';

/**
 * Lines someone other than the conversation's own voice says: an agent's answer, in the agent's voice. A Gemini
 * Live session speaks in one voice for its whole length, so these are played here, on the device (a local voice,
 * else a system one), one at a time and only when the floor is free. While one plays the session holds its
 * microphone, so the agent's voice is never taken for the user's.
 */

export type LineTts = EconomyEngines['tts'];

export interface SpokenLine {
  text: string;
  tts: LineTts;
}

export interface LineSpeech {
  speak: (text: string, tts: LineTts) => Promise<void>;
  stop: (tts: LineTts) => void;
}

// What was said last this way, for the voice status (and the tests that check the voice)
let last: { text: string; engine: string; voice: string; at: number } | null = null;
export const lastSpokenLine = () => last;

export class SpokenLines {
  private queue: SpokenLine[] = [];
  private current: SpokenLine | null = null;

  constructor(private readonly speech: LineSpeech) {}

  /** A line is playing now. */
  get voicing(): boolean {
    return this.current !== null;
  }

  get waiting(): number {
    return this.queue.length;
  }

  push(line: SpokenLine): void {
    if (line.text.trim()) this.queue.push(line);
  }

  /**
   * Plays the next line if there is one and the floor is free; resolves with it once it has been heard (or
   * stopped, or failed), or with null when nothing started.
   */
  async next(floorFree: boolean, onStart?: (line: SpokenLine) => void): Promise<SpokenLine | null> {
    if (this.current || !floorFree) return null;
    const line = this.queue.shift();
    if (!line) return null;
    this.current = line;
    onStart?.(line);
    last = { text: line.text, engine: line.tts.engine, voice: line.tts.voice, at: Date.now() };
    try {
      await this.speech.speak(line.text, line.tts);
    } catch {
      // A voice that failed says nothing; the conversation goes on
    } finally {
      this.current = null;
    }
    return line;
  }

  /** Stops the line playing and drops the rest. */
  stop(): void {
    this.queue = [];
    if (this.current) this.speech.stop(this.current.tts);
    this.current = null;
  }
}

/**
 * The device's voices from the offscreen document: the system's through the background (an offscreen document has
 * no chrome.tts), the local ones here. A local voice that cannot speak (its files are not downloaded) gives way to
 * the system's.
 */
export function deviceSpeech(local: {
  speak: (request: { engine: 'kitten' | 'kokoro'; text: string; voice: string; rate?: number }) => Promise<void>;
  stop: () => void;
}): LineSpeech {
  const system = async (text: string, tts: LineTts) => {
    const reply = (await chrome.runtime.sendMessage({
      type: 'voice_engine_system_say',
      text,
      rate: tts.rate,
      ...(tts.engine === 'system' && tts.voice ? { voice: tts.voice } : {}),
    })) as { ok?: boolean; error?: string } | undefined;
    if (reply?.error) throw new Error(reply.error);
  };
  return {
    speak: async (text, tts) => {
      if (tts.engine === 'system') return system(text, tts);
      try {
        await local.speak({ engine: tts.engine, text, voice: tts.voice, rate: tts.rate });
      } catch {
        await system(text, { ...tts, engine: 'system', voice: '' });
      }
    },
    stop: tts => {
      if (tts.engine === 'system')
        void chrome.runtime.sendMessage({ type: 'voice_engine_system_stop' }).catch(() => {});
      else local.stop();
    },
  };
}
