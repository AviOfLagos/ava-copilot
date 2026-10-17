import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { t } from '@extension/i18n';
import { audioDeviceSettingsStore } from '@extension/storage';
import { requestMicStream } from '@extension/shared';

// The longest recording, so a forgotten microphone does not run on
const MAX_RECORDING_MS = 2 * 60 * 1000;
// How long the background may take to write the words down before the panel gives up waiting
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;

/**
 * Where dictation is: the microphone starting, listening, or the words being written down. Each one is shown,
 * so the user always knows whether they are being heard.
 */
export type SpeechStatus = 'idle' | 'starting' | 'listening' | 'transcribing';

export interface SpeechInput {
  status: SpeechStatus;
  // When the microphone went live, for the timer
  startedAt: number | null;
  // The microphone's loudness now, 0 to 1, read on animation frames so the panel does not re-render for it
  level: MutableRefObject<number>;
  // Starts listening, or finishes (the recording is then written down)
  toggle: () => Promise<void>;
  // Drops the recording without writing it down
  cancel: () => void;
  // The background answered (the words, or an error)
  done: () => void;
}

/** Loudness of the samples on a 0–1 scale that follows how loud it sounds: -60 dB is silence, -10 dB is full. */
export function meterLevel(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  const decibels = 20 * Math.log10(Math.max(rms, 1e-5));
  return Math.min(1, Math.max(0, (decibels + 60) / 50));
}

/**
 * Records from the microphone and hands the audio to `send` as a data URL, for the background to write down.
 * Asks for microphone permission in a small window the first time. `hold` is told when the microphone is the
 * dictation's (true) and when it is given back (false): a voice conversation and the wake word must not hear the
 * dictated words too, or Ava answers them as well as the chat.
 */
export function useSpeechInput(
  send: (audio: string) => void,
  onError: (message: string) => void,
  hold: (on: boolean) => void = () => {},
): SpeechInput {
  const [status, setStatusState] = useState<SpeechStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const statusRef = useRef<SpeechStatus>('idle');
  const level = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef = useRef<{ context: AudioContext; frame: number } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const maxTimerRef = useRef<number | null>(null);
  const transcribeTimerRef = useRef<number | null>(null);
  // The latest callbacks, for the recorder's events
  const sendRef = useRef(send);
  const onErrorRef = useRef(onError);
  const holdRef = useRef(hold);
  // Whether the microphone is held for dictation now, so it is given back exactly once
  const heldRef = useRef(false);
  sendRef.current = send;
  onErrorRef.current = onError;
  holdRef.current = hold;

  const setHeld = useCallback((on: boolean) => {
    if (heldRef.current === on) return;
    heldRef.current = on;
    try {
      holdRef.current(on);
    } catch {
      // The panel's connection is gone; the background gives the microphone back when it notices
    }
  }, []);

  // Read through a call: the status changes while start() awaits
  const statusNow = useCallback((): SpeechStatus => statusRef.current, []);

  const setStatus = useCallback((next: SpeechStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const clearTimer = (timer: MutableRefObject<number | null>) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  /** Stops the microphone and the meter, and gives the microphone back to the conversation. */
  const release = useCallback(() => {
    setHeld(false);
    clearTimer(maxTimerRef);
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    const meter = meterRef.current;
    meterRef.current = null;
    if (meter) {
      cancelAnimationFrame(meter.frame);
      void meter.context.close().catch(() => {});
    }
    level.current = 0;
  }, [setHeld]);

  /** Follows the microphone's loudness. Only feedback: dictation works without it. */
  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const meter = { context, frame: 0 };
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        // Rises fast and falls back slowly, as a level meter does
        const now = meterLevel(samples);
        level.current = now > level.current ? now : level.current * 0.85 + now * 0.15;
        meter.frame = requestAnimationFrame(tick);
      };
      meter.frame = requestAnimationFrame(tick);
      meterRef.current = meter;
      void context.resume().catch(() => {});
    } catch {
      level.current = 0;
    }
  }, []);

  /** Finishes listening: the recording is written down, or dropped when `discard`. */
  const finish = useCallback(
    (discard: boolean) => {
      clearTimer(maxTimerRef);
      discardRef.current = discard;
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') {
        recorder.stop();
        return;
      }
      // Nothing recorded yet (the microphone was still starting): there is nothing to write down
      release();
      setStartedAt(null);
      setStatus('idle');
    },
    [release, setStatus],
  );

  const start = useCallback(async () => {
    if (statusNow() !== 'idle') return;
    setStatus('starting');
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permission.state === 'denied') {
        setStatus('idle');
        onErrorRef.current(t('chat_stt_microphone_permissionDenied'));
        return;
      }
      if (permission.state !== 'granted') {
        // The permission page asks; the user presses the mic again afterwards
        setStatus('idle');
        await chrome.windows.create({
          url: chrome.runtime.getURL('permission/index.html'),
          type: 'popup',
          width: 500,
          height: 600,
        });
        return;
      }

      // From here the microphone is the dictation's: the conversation and the wake word stop hearing it
      setHeld(true);
      const micDeviceId = (await audioDeviceSettingsStore.getSettings()).mic?.deviceId ?? null;
      const stream = await requestMicStream(navigator.mediaDevices, micDeviceId, {});
      // Stopped while the microphone was starting
      if (statusNow() !== 'starting') {
        stream.getTracks().forEach(track => track.stop());
        setHeld(false);
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      discardRef.current = false;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstart = () => {
        setStartedAt(Date.now());
        setStatus('listening');
      };
      recorder.onstop = () => {
        release();
        setStartedAt(null);
        recorderRef.current = null;
        if (discardRef.current || chunksRef.current.length === 0) {
          setStatus('idle');
          return;
        }
        setStatus('transcribing');
        transcribeTimerRef.current = window.setTimeout(() => {
          transcribeTimerRef.current = null;
          if (statusRef.current !== 'transcribing') return;
          setStatus('idle');
          onErrorRef.current(t('chat_stt_timeout'));
        }, TRANSCRIBE_TIMEOUT_MS);
        const reader = new FileReader();
        reader.onloadend = () => {
          try {
            sendRef.current(reader.result as string);
          } catch {
            clearTimer(transcribeTimerRef);
            setStatus('idle');
            onErrorRef.current(t('chat_stt_processingFailed'));
          }
        };
        reader.readAsDataURL(new Blob(chunksRef.current, { type: 'audio/webm' }));
      };
      startMeter(stream);
      maxTimerRef.current = window.setTimeout(() => finish(false), MAX_RECORDING_MS);
      recorder.start();
    } catch (error) {
      release();
      setStartedAt(null);
      setStatus('idle');
      let message = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') message += t('chat_stt_microphone_grantPermission');
        else if (error.name === 'NotFoundError') message += t('chat_stt_microphone_notFound');
        else message += error.message;
      }
      onErrorRef.current(message);
    }
  }, [finish, release, setHeld, setStatus, startMeter, statusNow]);

  const toggle = useCallback(async () => {
    if (statusRef.current === 'idle') await start();
    else if (statusRef.current !== 'transcribing') finish(false);
  }, [finish, start]);

  const cancel = useCallback(() => {
    if (statusRef.current === 'starting' || statusRef.current === 'listening') finish(true);
  }, [finish]);

  const done = useCallback(() => {
    clearTimer(transcribeTimerRef);
    if (statusRef.current === 'transcribing') setStatus('idle');
  }, [setStatus]);

  // Closing the panel drops a recording under way
  useEffect(
    () => () => {
      discardRef.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      release();
      clearTimer(transcribeTimerRef);
    },
    [release],
  );

  return { status, startedAt, level, toggle, cancel, done };
}
