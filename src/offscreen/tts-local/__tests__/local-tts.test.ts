import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_UNLOAD_MS, LocalTts } from '../local-tts';
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
});
