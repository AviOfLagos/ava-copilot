import { afterEach, describe, expect, it, vi } from 'vitest';
import { headStartSeconds, IDLE_UNLOAD_MS, LocalTts, MAX_HEAD_START_SECONDS } from '../local-tts';
import type { PcmPlayer } from '../player';
import type { FromTtsWorker, ToTtsWorker } from '../protocol';

class FakeWorker {
  sent: ToTtsWorker[] = [];
  terminated = false;
  onmessage: ((event: { data: FromTtsWorker }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(message: ToTtsWorker) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: FromTtsWorker) {
    this.onmessage?.({ data });
  }
}

class FakePlayer {
  clips: Float32Array[] = [];
  stops = 0;
  playing = false;
  peakRms = 0.3;
  playedSeconds = 0;
  gapCount = 0;
  gapMs = 0;
  longestGapMs = 0;
  private drained: (() => void)[] = [];
  enqueue(samples: Float32Array) {
    this.clips.push(samples);
    this.playing = true;
    this.playedSeconds += samples.length / 24_000;
  }
  whenDrained() {
    return this.playing ? new Promise<void>(resolve => this.drained.push(resolve)) : Promise.resolve();
  }
  finishPlaying() {
    this.playing = false;
    for (const resolve of this.drained.splice(0)) resolve();
  }
  stop() {
    this.stops++;
    this.finishPlaying();
  }
  resetStats() {
    this.playedSeconds = 0;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const player = new FakePlayer();
  const tts = new LocalTts(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    'chrome-extension://test/voice/',
    player as unknown as PcmPlayer,
  );
  return { tts, player, worker: () => workers[workers.length - 1], workers };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('LocalTts', () => {
  it('loads the model on first use, speaks sentence by sentence, and resolves once heard', async () => {
    const { tts, player, worker } = setup();
    const spoken = tts.speak({ engine: 'kitten', text: 'Hello. There.', voice: 'Leo', rate: 1.2 });
    let done = false;
    void spoken.then(() => (done = true));

    expect(worker().sent[0]).toEqual({ type: 'load', engine: 'kitten', base: 'chrome-extension://test/voice/' });
    worker().emit({ type: 'loaded', engine: 'kitten', ms: 900 });
    await flush();
    const speak = worker().sent[1] as Extract<ToTtsWorker, { type: 'speak' }>;
    expect(speak).toMatchObject({ type: 'speak', engine: 'kitten', text: 'Hello. There.', voice: 'Leo', speed: 1.2 });

    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array(24_000), sampleRate: 24_000, ms: 400 });
    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array(12_000), sampleRate: 24_000, ms: 200 });
    expect(player.clips).toHaveLength(2);
    expect(tts.speaking).toBe(true);

    worker().emit({ type: 'done', id: speak.id });
    await flush();
    // Made, but still playing
    expect(done).toBe(false);
    player.finishPlaying();
    await flush();
    expect(done).toBe(true);
    expect(tts.speaking).toBe(false);
    expect(tts.stats).toMatchObject({ engine: 'kitten', speedFactor: 2.5, peakRms: 0.3, playedSeconds: 1.5 });
  });

  it('stops at once: the rest is cancelled and the request resolves', async () => {
    const { tts, player, worker } = setup();
    const spoken = tts.speak({ engine: 'kitten', text: 'A long answer.', voice: 'Bella' });
    worker().emit({ type: 'loaded', engine: 'kitten', ms: 1 });
    await flush();
    const speak = worker().sent[1] as Extract<ToTtsWorker, { type: 'speak' }>;
    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array(100), sampleRate: 24_000, ms: 1 });

    tts.stop();
    await expect(spoken).resolves.toBeUndefined();
    expect(worker().sent.at(-1)).toEqual({ type: 'cancel', id: speak.id });
    expect(player.stops).toBeGreaterThan(0);
    // Audio still on its way from the cancelled request is not played
    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array(100), sampleRate: 24_000, ms: 1 });
    expect(player.clips).toHaveLength(1);
  });

  it('a new request cuts off the one before', async () => {
    const { tts, worker } = setup();
    const first = tts.speak({ engine: 'kitten', text: 'One.', voice: 'Bella' });
    worker().emit({ type: 'loaded', engine: 'kitten', ms: 1 });
    await flush();
    const second = tts.speak({ engine: 'kitten', text: 'Two.', voice: 'Bella' });
    await expect(first).resolves.toBeUndefined();
    await flush();
    const speaks = worker().sent.filter(message => message.type === 'speak');
    expect(speaks.map(message => message.text)).toEqual(['One.', 'Two.']);
    worker().emit({ type: 'done', id: speaks[1].id });
    await expect(second).resolves.toBeUndefined();
  });

  it('a failed load fails the request, and the next one tries again', async () => {
    const { tts, worker } = setup();
    const spoken = tts.speak({ engine: 'kokoro', text: 'Hi.', voice: 'af_heart' });
    worker().emit({ type: 'error', message: 'kokoro/config.json is missing' });
    await expect(spoken).rejects.toThrow('kokoro/config.json is missing');

    void tts.speak({ engine: 'kokoro', text: 'Hi.', voice: 'af_heart' }).catch(() => {});
    expect(worker().sent.filter(message => message.type === 'load')).toHaveLength(2);
  });

  it('frees the model after a quiet spell', async () => {
    vi.useFakeTimers();
    const { tts, worker } = setup();
    const warm = tts.warm('kitten');
    worker().emit({ type: 'loaded', engine: 'kitten', ms: 1 });
    await warm;
    expect(tts.loaded).toBe(true);
    vi.advanceTimersByTime(IDLE_UNLOAD_MS + 1);
    expect(worker().terminated).toBe(true);
    expect(tts.loaded).toBe(false);
  });

  it('renders speech to a buffer without playing it (words for a call)', async () => {
    const { tts, player, worker } = setup();
    const rendered = tts.render({ engine: 'kokoro', text: 'Hello. There.', voice: 'af_heart' });
    worker().emit({ type: 'loaded', engine: 'kokoro', ms: 10 });
    await flush();
    const speak = worker().sent.find(message => message.type === 'speak');
    if (speak?.type !== 'speak') throw new Error('no speak message');
    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array([0.1, 0.2]), sampleRate: 24_000, ms: 5 });
    worker().emit({ type: 'audio', id: speak.id, samples: new Float32Array([0.3]), sampleRate: 24_000, ms: 5 });
    worker().emit({ type: 'done', id: speak.id });
    const speech = await rendered;
    expect([...speech.samples].map(value => +value.toFixed(1))).toEqual([0.1, 0.2, 0.3]);
    expect(speech.sampleRate).toBe(24_000);
    expect(player.clips).toHaveLength(0);
    expect(tts.speaking).toBe(false);
  });

  it('a stop cancels a render', async () => {
    const { tts, worker } = setup();
    const rendered = tts.render({ engine: 'kitten', text: 'Hello.', voice: 'Leo' });
    worker().emit({ type: 'loaded', engine: 'kitten', ms: 10 });
    await flush();
    tts.stop();
    await expect(rendered).rejects.toThrow('Stopped');
  });

  describe('a voice slower than it plays', () => {
    // 24 000 samples is a second of speech
    const clip = (seconds: number) => new Float32Array(Math.round(seconds * 24_000));

    async function start(text: string, onSpoken?: (report: unknown) => void) {
      const ctx = setup();
      if (onSpoken) ctx.tts.onSpoken = onSpoken;
      const spoken = ctx.tts.speak({ engine: 'kitten', text, voice: 'Leo' });
      ctx.worker().emit({ type: 'loaded', engine: 'kitten', ms: 1 });
      await flush();
      const speak = ctx.worker().sent[1] as Extract<ToTtsWorker, { type: 'speak' }>;
      return { ...ctx, spoken, speak };
    }

    it('holds the first sentences back until the head start covers the rest, then plays them together', async () => {
      const { player, worker, speak } = await start(
        'The first sentence is here. The second one follows it. A third one comes after. And the last one ends it.',
      );
      // 4 s of speech made in 6 s of work: 0.67× real time, so the rest (about 12 s) needs a long head start
      worker().emit({ type: 'audio', id: speak.id, samples: clip(4), sampleRate: 24_000, ms: 6000, chars: 27 });
      expect(player.clips).toHaveLength(0);
      worker().emit({ type: 'audio', id: speak.id, samples: clip(4), sampleRate: 24_000, ms: 6000, chars: 27 });
      expect(player.clips).toHaveLength(2);
      // From here on each sentence plays as it arrives
      worker().emit({ type: 'audio', id: speak.id, samples: clip(4), sampleRate: 24_000, ms: 6000, chars: 27 });
      expect(player.clips).toHaveLength(3);
    });

    it('plays at once when the voice keeps up', async () => {
      const { player, worker, speak } = await start('One sentence here. Another sentence there.');
      worker().emit({ type: 'audio', id: speak.id, samples: clip(2), sampleRate: 24_000, ms: 500, chars: 18 });
      expect(player.clips).toHaveLength(1);
    });

    it('plays what was held when the request is done, even a single short sentence', async () => {
      const { player, worker, speak } = await start('A slow short line.');
      worker().emit({ type: 'audio', id: speak.id, samples: clip(2), sampleRate: 24_000, ms: 6000, chars: 18 });
      worker().emit({ type: 'done', id: speak.id });
      expect(player.clips).toHaveLength(1);
    });

    it('reports the answer with sizes and times only, once it has been heard', async () => {
      const reports: unknown[] = [];
      const { player, worker, speak, spoken } = await start('Hello there. How are you today?', r => reports.push(r));
      worker().emit({ type: 'audio', id: speak.id, samples: clip(1), sampleRate: 24_000, ms: 400, chars: 12 });
      worker().emit({ type: 'audio', id: speak.id, samples: clip(2), sampleRate: 24_000, ms: 800, chars: 18 });
      worker().emit({ type: 'done', id: speak.id });
      await flush();
      player.finishPlaying();
      await spoken;
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ engine: 'kitten', ok: true, chars: 30, speed: 2.5, audioSeconds: 3 });
      // No words in it
      expect(JSON.stringify(reports[0])).not.toMatch(/Hello|today/);
    });

    it('reports a failure as one', async () => {
      const reports: { ok: boolean; note?: string }[] = [];
      const { worker, speak, spoken } = await start('Hello there.', r => reports.push(r as never));
      worker().emit({ type: 'error', id: speak.id, message: 'the model fell over' });
      await expect(spoken).rejects.toThrow('the model fell over');
      expect(reports).toEqual([expect.objectContaining({ ok: false, note: 'failed' })]);
    });
  });
});

describe('headStartSeconds', () => {
  it('needs none from a voice that keeps up, or when nothing is left to make', () => {
    expect(headStartSeconds(1.5, 20)).toBe(0);
    expect(headStartSeconds(1.12, 20)).toBe(0);
    expect(headStartSeconds(0.5, 0)).toBe(0);
  });

  it('covers what the voice falls behind, with a margin, and never more than the cap', () => {
    // 0.7× counted as 0.63×: 10 s still to make falls behind by 10 * 0.37 / 0.63 ≈ 5.9 s
    expect(headStartSeconds(0.7, 10)).toBeCloseTo(5.87, 1);
    expect(headStartSeconds(0.2, 30)).toBe(MAX_HEAD_START_SECONDS);
  });
});
