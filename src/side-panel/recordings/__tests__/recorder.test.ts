import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(async () => {
  const { installChrome } = await import('../../../background/backup/__tests__/helpers');
  installChrome();
});

import { pickMimeType, rms, ScreenRecorder, SilenceWatch } from '../recorder';
import type { RecorderDeps } from '../recorder';

function fakeTrack(surface: string) {
  return { stop: vi.fn(), getSettings: () => ({ displaySurface: surface }), addEventListener: vi.fn() };
}

function setup(options: { activated: boolean; surface?: string; refuse?: boolean }) {
  const track = fakeTrack(options.surface ?? 'browser');
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  const order: string[] = [];
  const getDisplayMedia = vi.fn((constraints: DisplayMediaStreamOptions) => {
    order.push('getDisplayMedia');
    void constraints;
    return options.refuse
      ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      : Promise.resolve(stream as unknown as MediaStream);
  });
  const getUserMedia = vi.fn(() => Promise.reject(new Error('no mic in tests')));
  const request = vi.fn(async () => {
    order.push('request');
    return { id: 'rec_aaaaaaaaaa', maxMinutes: 10 } as never;
  });
  const deps: RecorderDeps = {
    request,
    media: () => ({ getDisplayMedia, getUserMedia }) as unknown as MediaDevices,
    activated: () => options.activated,
    connect: () => ({ postMessage: vi.fn(), disconnect: vi.fn() }) as unknown as chrome.runtime.Port,
    now: () => 0,
  };
  return { recorder: new ScreenRecorder(deps), getDisplayMedia, getUserMedia, request, track, order };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the screen recorder', () => {
  it('never starts without a click: no picker, no record', async () => {
    const { recorder, getDisplayMedia, request } = setup({ activated: false });
    expect(recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' })).toBe(false);
    await settle();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(recorder.current.phase).toBe('idle');
  });

  it('calls getDisplayMedia first, inside the click, with tabs offered first and this panel left out', () => {
    const { recorder, getDisplayMedia, order } = setup({ activated: true });
    expect(recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' })).toBe(true);
    // Synchronously: before start() returned, before any await or message
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['getDisplayMedia']);
    const options = getDisplayMedia.mock.calls[0][0] as DisplayMediaStreamOptions & {
      video: { displaySurface: string };
      selfBrowserSurface: string;
    };
    expect(options.video.displaySurface).toBe('browser');
    expect(options.selfBrowserSurface).toBe('exclude');
    expect(options.audio).toBeTruthy();
    expect(recorder.current.phase).toBe('picking');
  });

  it('a second click while one is on starts nothing', () => {
    const { recorder, getDisplayMedia } = setup({ activated: true });
    recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' });
    expect(recorder.start({ id: 'tsk_bbbbbbbbbb', title: 'Other' })).toBe(false);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('a whole screen waits for "Record anyway"; Cancel records nothing and lets the screen go', async () => {
    const { recorder, request, track } = setup({ activated: true, surface: 'monitor' });
    recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' });
    await settle();
    expect(recorder.current.phase).toBe('confirm_surface');
    expect(recorder.current.surface).toBe('monitor');
    recorder.cancel();
    await settle();
    expect(recorder.current.phase).toBe('idle');
    expect(track.stop).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('a window waits too', async () => {
    const { recorder } = setup({ activated: true, surface: 'window' });
    recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' });
    await settle();
    expect(recorder.current.phase).toBe('confirm_surface');
  });

  it('closing the picker records nothing', async () => {
    const { recorder, request } = setup({ activated: true, refuse: true });
    recorder.start({ id: 'tsk_aaaaaaaaaa', title: 'Demo' });
    await settle();
    expect(recorder.current.phase).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('recorder helpers', () => {
  it('picks the best WebM the browser writes', () => {
    expect(pickMimeType(type => type === 'video/webm;codecs=vp8,opus')).toBe('video/webm;codecs=vp8,opus');
    expect(pickMimeType(() => false)).toBe('video/webm');
  });

  it('stops after two minutes of silence, and any sound starts the count again', () => {
    const watch = new SilenceWatch(0);
    expect(watch.hear(0, 60_000)).toBe(false);
    expect(watch.hear(0.2, 100_000)).toBe(false);
    expect(watch.hear(0, 219_000)).toBe(false);
    expect(watch.hear(0, 220_000)).toBe(true);
  });

  it('measures a level', () => {
    expect(rms(new Float32Array([0, 0]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});
