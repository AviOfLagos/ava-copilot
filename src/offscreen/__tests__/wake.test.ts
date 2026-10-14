import { describe, expect, it, vi } from 'vitest';
import { AudioRing, heardWake, heyAvaPrefix, wakeGrammars, WakeListener, wakePrefix } from '../wake';

describe('heardWake', () => {
  it('hears the phrase, alone or with a request after it', () => {
    expect(heardWake('hey ava')).toBe(true);
    expect(heardWake('[unk] hey ava [unk]')).toBe(true);
    expect(heardWake('[unk]')).toBe(false);
    expect(heardWake('')).toBe(false);
    expect(heardWake(undefined)).toBe(false);
  });
});

describe('heyAvaPrefix', () => {
  it('accepts a VERIFY_GRAMMAR transcript that starts with "hey ava"', () => {
    expect(heyAvaPrefix('hey ava')).toBe(true);
    // The verified window can run a little past "ava" into the next word, which the verifier's
    // own grammar then tags as trailing "[unk]" tokens (seen on "Hey Ava, what's on my calendar").
    expect(heyAvaPrefix('hey ava [unk]')).toBe(true);
    expect(heyAvaPrefix('hey ava [unk] [unk]')).toBe(true);
    expect(heyAvaPrefix('HEY AVA')).toBe(true);
    expect(heyAvaPrefix('  hey   ava  ')).toBe(true);
  });

  it('rejects everything a "hey"-only or unrelated utterance can decode to in that grammar', () => {
    expect(heyAvaPrefix('hey')).toBe(false);
    expect(heyAvaPrefix('hey hey')).toBe(false);
    expect(heyAvaPrefix('[unk]')).toBe(false);
    expect(heyAvaPrefix('[unk] hey')).toBe(false);
    expect(heyAvaPrefix('hey there ava')).toBe(false); // the name comes first or right after one word
  });

  it('forgives a real voice: an unclear or misheard "hey" before the name', () => {
    expect(heyAvaPrefix('[unk] ava')).toBe(true);
    expect(heyAvaPrefix('[unk] hey ava')).toBe(true);
    expect(heyAvaPrefix('[unk] [unk] hey ava [unk]')).toBe(true);
  });

  it('stays strict where waking would send audio out by mistake', () => {
    expect(heyAvaPrefix('ava')).toBe(false);
    expect(heyAvaPrefix('[unk] [unk] ava')).toBe(false);
    expect(heyAvaPrefix('hey [unk] ava')).toBe(false);
    expect(heyAvaPrefix('')).toBe(false);
    expect(heyAvaPrefix(undefined)).toBe(false);
  });
});

describe('a wake phrase for another name', () => {
  it('keeps the measured grammars for Ava and swaps the name in for others', () => {
    expect(wakeGrammars(['ava'])).toEqual({ listen: ['hey ava', '[unk]'], verify: ['hey ava', 'hey', 'ava', '[unk]'] });
    expect(wakeGrammars(['nova'])).toEqual({
      listen: ['hey nova', '[unk]'],
      verify: ['hey nova', 'hey', 'nova', '[unk]'],
    });
    expect(wakeGrammars(['mary', 'jane']).verify).toEqual(['hey mary jane', 'hey', 'mary jane', '[unk]']);
  });

  it('checks "hey" then every word of the name, in order', () => {
    expect(wakePrefix('hey nova [unk]', ['nova'])).toBe(true);
    expect(wakePrefix('hey mary jane', ['mary', 'jane'])).toBe(true);
    expect(wakePrefix('hey mary [unk]', ['mary', 'jane'])).toBe(false);
    expect(wakePrefix('hey ava', ['nova'])).toBe(false);
    expect(wakePrefix('nova', ['nova'])).toBe(false);
    expect(wakePrefix('[unk] nova', ['nova'])).toBe(true);
    expect(wakePrefix('hey there nova', ['nova'])).toBe(false);
    expect(heardWake('hey nova', 'hey nova')).toBe(true);
    expect(heardWake('hey ava', 'hey nova')).toBe(false);
  });
});

describe('AudioRing', () => {
  it('keeps only the last seconds, in order, and empties when taken', () => {
    const ring = new AudioRing(4);
    for (const value of [1, 2, 3]) ring.push(new Float32Array([value, value]));
    expect(ring.take().map(chunk => chunk[0])).toEqual([2, 3]);
    expect(ring.take()).toEqual([]);
  });
});

describe('WakeListener verification', () => {
  type Sent = { action: string; recognizerId?: string; grammar?: string; data?: Float32Array };

  /** A listener on a stand-in worker: what it sends is recorded, and replies are handed in by the test. */
  function listen(words?: string[]) {
    const sent: Sent[] = [];
    const wakes: number[] = [];
    const listener = new WakeListener(() => wakes.push(Date.now()));
    if (words) (listener as unknown as { wakeWords: string[] }).wakeWords = words;
    const internals = listener as unknown as {
      worker: { postMessage: (message: Sent) => void } | null;
      recognizerId: string;
      feed: (samples: Float32Array) => void;
      handle: (message: Record<string, unknown>) => void;
      capture: Float32Array[] | null;
    };
    internals.worker = { postMessage: message => sent.push(message) };
    const chunk = (value: number) => new Float32Array(1600).fill(value); // 100 ms
    return {
      listener,
      sent,
      wakes,
      feed: (value: number, times = 1) => {
        for (let index = 0; index < times; index++) internals.feed(chunk(value));
      },
      // The main recogniser hears the phrase (or thinks it does)
      candidate: (partial = 'hey ava') =>
        internals.handle({
          event: 'partialresult',
          recognizerId: internals.recognizerId,
          result: { partial },
        }),
      verifier: () => sent.find(message => message.action === 'create' && message.grammar)?.recognizerId,
      // The verifier's two answers: the chunk's, then the final one
      answer: async (text: string) => {
        const id = sent.find(message => message.action === 'create' && message.grammar)?.recognizerId;
        internals.handle({ event: 'partialresult', recognizerId: id, result: { partial: '' } });
        internals.handle({ event: 'result', recognizerId: id, result: { text } });
        await new Promise(resolve => setTimeout(resolve, 0));
      },
      capture: () => internals.capture,
      mainChunks: () => sent.filter(message => message.action === 'audioChunk' && message.recognizerId !== undefined),
    };
  }

  it('wakes only when the second decode hears "hey ava", keeping what was said while it decoded', async () => {
    const wake = listen();
    wake.feed(0.125, 3);
    wake.candidate();
    expect(wake.wakes).toHaveLength(0);
    // 250 ms of tail, then the decode starts on a recogniser with the richer grammar
    wake.feed(0.25, 3);
    expect(JSON.parse(wake.sent.find(message => message.grammar)?.grammar ?? '[]')).toContain('hey');
    // Speech goes on while it decodes: kept for the conversation
    wake.feed(0.5, 2);
    await wake.answer('hey ava [unk]');
    expect(wake.wakes).toHaveLength(1);
    const kept = wake.capture() ?? [];
    expect(kept.some(chunk => chunk[0] === 0.5)).toBe(true);
    expect(wake.sent.some(message => message.action === 'remove' && message.recognizerId === wake.verifier())).toBe(
      true,
    );
  });

  it('verifies a custom phrase with a grammar of its own name', async () => {
    const wake = listen(['nova']);
    // The default phrase is not a candidate any more
    wake.candidate('hey ava');
    wake.feed(0.2, 3);
    expect(wake.verifier()).toBeUndefined();
    wake.candidate('hey nova');
    wake.feed(0.2, 3);
    expect(JSON.parse(wake.sent.find(message => message.grammar)?.grammar ?? '[]')).toEqual([
      'hey nova',
      'hey',
      'nova',
      '[unk]',
    ]);
    await wake.answer('hey ava');
    expect(wake.wakes).toHaveLength(0);
  });

  it('wakes on a confirmed custom phrase', async () => {
    const wake = listen(['nova']);
    wake.candidate('hey nova');
    wake.feed(0.2, 3);
    await wake.answer('hey nova [unk]');
    expect(wake.wakes).toHaveLength(1);
  });

  it('does not wake on "hey" alone, and listens again', async () => {
    const wake = listen();
    wake.feed(0.1, 3);
    wake.candidate();
    wake.feed(0.2, 3);
    await wake.answer('hey [unk]');
    expect(wake.wakes).toHaveLength(0);
    expect(wake.capture()).toBeNull();
    const before = wake.mainChunks().length;
    wake.feed(0.1, 2);
    expect(wake.mainChunks().length).toBe(before + 2);
  });

  it('gives up on a decode that never answers, and listens again', async () => {
    vi.useFakeTimers();
    try {
      const wake = listen();
      wake.candidate();
      wake.feed(0.2, 3);
      await vi.advanceTimersByTimeAsync(3100);
      expect(wake.wakes).toHaveLength(0);
      const before = wake.mainChunks().length;
      wake.feed(0.1, 1);
      expect(wake.mainChunks().length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wake when listening pauses while it decodes', async () => {
    const wake = listen();
    wake.candidate();
    wake.feed(0.2, 3);
    wake.listener.pause();
    await wake.answer('hey ava');
    expect(wake.wakes).toHaveLength(0);
  });
});
