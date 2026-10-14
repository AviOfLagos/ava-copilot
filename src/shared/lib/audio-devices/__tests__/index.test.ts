import { describe, expect, it, vi } from 'vitest';
import {
  devicesOfKind,
  fallbackLabel,
  micConstraints,
  requestMicStream,
  resolveAudioDevice,
  setAudioSinkId,
  type AudioDeviceOption,
} from '../index';

const mic1: AudioDeviceOption = { deviceId: 'id-1', label: 'USB Microphone', kind: 'audioinput' };
const mic2: AudioDeviceOption = { deviceId: 'id-2', label: 'Built-in Microphone', kind: 'audioinput' };
const speaker1: AudioDeviceOption = { deviceId: 'id-3', label: 'USB Speakers', kind: 'audiooutput' };

describe('resolveAudioDevice', () => {
  it('resolves to the system default when nothing is chosen', () => {
    expect(resolveAudioDevice([mic1, mic2], null)).toEqual({ deviceId: null, connected: true });
  });

  it('matches by deviceId when the device is still present with the same id', () => {
    expect(resolveAudioDevice([mic1, mic2], { deviceId: 'id-1', label: 'USB Microphone' })).toEqual({
      deviceId: 'id-1',
      connected: true,
    });
  });

  it('falls back to matching by label when the deviceId changed between sessions', () => {
    // Same device, re-plugged in a new session: the browser gave it a new deviceId
    const reassigned: AudioDeviceOption = { deviceId: 'id-9-new', label: 'USB Microphone', kind: 'audioinput' };
    expect(resolveAudioDevice([reassigned, mic2], { deviceId: 'id-1', label: 'USB Microphone' })).toEqual({
      deviceId: 'id-9-new',
      connected: true,
    });
  });

  it('reports disconnected when neither the id nor the label is present', () => {
    expect(resolveAudioDevice([mic2], { deviceId: 'id-1', label: 'USB Microphone' })).toEqual({
      deviceId: null,
      connected: false,
    });
  });

  it('reports disconnected (not a crash) against an empty device list', () => {
    expect(resolveAudioDevice([], { deviceId: 'id-1', label: 'USB Microphone' })).toEqual({
      deviceId: null,
      connected: false,
    });
  });
});

describe('devicesOfKind', () => {
  it('splits mixed input/output devices by kind', () => {
    expect(devicesOfKind([mic1, mic2, speaker1], 'audioinput')).toEqual([mic1, mic2]);
    expect(devicesOfKind([mic1, mic2, speaker1], 'audiooutput')).toEqual([speaker1]);
  });
});

describe('fallbackLabel', () => {
  it('keeps a real label as-is', () => {
    expect(fallbackLabel(mic1, 0)).toBe('USB Microphone');
  });

  it('numbers an unlabeled device by kind, 1-based', () => {
    const unlabeled: AudioDeviceOption = { deviceId: 'id-7', label: '', kind: 'audioinput' };
    expect(fallbackLabel(unlabeled, 2)).toBe('Microphone 3');
    expect(fallbackLabel({ ...unlabeled, kind: 'audiooutput' }, 0)).toBe('Speaker 1');
  });
});

describe('micConstraints', () => {
  it('asks for no specific device on the system default, so there is nothing to overconstrain on', () => {
    expect(micConstraints(null)).toEqual({});
    expect(micConstraints(null, { echoCancellation: true })).toEqual({ echoCancellation: true });
  });

  it('adds an exact deviceId constraint for a chosen device, keeping the rest of the base constraints', () => {
    expect(micConstraints('id-1', { echoCancellation: true })).toEqual({
      echoCancellation: true,
      deviceId: { exact: 'id-1' },
    });
  });
});

describe('requestMicStream', () => {
  const fakeStream = {} as MediaStream;

  it('opens the chosen device directly when it works', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    const stream = await requestMicStream({ getUserMedia }, 'id-1', { echoCancellation: true });
    expect(stream).toBe(fakeStream);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, deviceId: { exact: 'id-1' } } });
  });

  it('asks with no deviceId at all for the system default', async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    await requestMicStream({ getUserMedia }, null, { echoCancellation: true });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true } });
  });

  it('falls back to the system default when the chosen device is gone (OverconstrainedError)', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('no match', 'OverconstrainedError'))
      .mockResolvedValueOnce(fakeStream);
    const stream = await requestMicStream({ getUserMedia }, 'id-1', { echoCancellation: true });
    expect(stream).toBe(fakeStream);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: { echoCancellation: true } });
  });

  it('falls back to the system default when the chosen device disappeared entirely (NotFoundError)', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('gone', 'NotFoundError'))
      .mockResolvedValueOnce(fakeStream);
    const stream = await requestMicStream({ getUserMedia }, 'id-1', {});
    expect(stream).toBe(fakeStream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('never falls back, and rethrows, when the system default itself was requested and denied', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(requestMicStream({ getUserMedia }, null, {})).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('rethrows an unrelated error (e.g. permission denied) without masking it as a device problem', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(requestMicStream({ getUserMedia }, 'id-1', {})).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('setAudioSinkId', () => {
  it('passes a chosen deviceId through to setSinkId', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    await setAudioSinkId({ setSinkId }, 'speaker-1');
    expect(setSinkId).toHaveBeenCalledWith('speaker-1');
  });

  it('asks for the empty string (the system default) when no device is chosen', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    await setAudioSinkId({ setSinkId }, null);
    expect(setSinkId).toHaveBeenCalledWith('');
  });

  it('does nothing where setSinkId is unsupported, instead of throwing', async () => {
    await expect(setAudioSinkId({}, 'speaker-1')).resolves.toBeUndefined();
  });

  it('swallows a rejection (e.g. a device that just disconnected) rather than breaking playback', async () => {
    const setSinkId = vi.fn().mockRejectedValue(new Error('no such sink'));
    await expect(setAudioSinkId({ setSinkId }, 'speaker-1')).resolves.toBeUndefined();
  });
});
