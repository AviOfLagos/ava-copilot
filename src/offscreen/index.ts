import { Recorder } from './recorder';
import type { RecorderOptions } from './recorder';
import type { VoiceOptions } from './voice';
import { WakeListener } from './wake';
import { TtsPlayer } from './tts';
import { createVoiceSession } from './stt/economy';
import type { AnyVoiceSession, EconomyOptions } from './stt/economy';
import './tts-local/register';

/**
 * The offscreen document holds the meeting's media streams, which a service worker cannot.
 * It takes commands from the background and reports back to it.
 */
let recorder: Recorder | null = null;
let voice: AnyVoiceSession | null = null;
// Plays cloud voices (Gemini TTS) the background fetched; the key never comes here
let tts: TtsPlayer | null = null;
const wake = new WakeListener(() => {
  chime();
  notify({ type: 'wake_word' });
});

/** A short rising tone: the copilot heard its name. */
function chime(): void {
  const context = new AudioContext();
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.setValueAtTime(660, context.currentTime);
  tone.frequency.linearRampToValueAtTime(990, context.currentTime + 0.15);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.3);
  tone.connect(gain).connect(context.destination);
  tone.start();
  tone.stop(context.currentTime + 0.32);
  tone.onended = () => void context.close();
}

const notify = (message: Record<string, unknown>) => {
  chrome.runtime.sendMessage(message).catch(() => {
    // The background wakes for the next message; the chunk itself is already in the database
  });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id) {
    return;
  }
  (async () => {
    switch (message.type) {
      case 'recorder_start': {
        if (recorder) {
          return { ok: false, error: 'Already recording' };
        }
        const next = new Recorder(message.options as RecorderOptions, notify);
        try {
          await next.start();
        } catch (error) {
          await next.stop().catch(() => {});
          return { ok: false, error: String(error) };
        }
        recorder = next;
        return { ok: true, micUsed: next.micUsed };
      }
      case 'recorder_stop': {
        const current = recorder;
        recorder = null;
        if (!current || current.options.meetingId !== message.meetingId) {
          return { ok: false, error: 'Not recording this meeting' };
        }
        await current.stop();
        return { ok: true };
      }
      case 'recorder_stop_live':
        recorder?.stopLive();
        return { ok: true };
      case 'voice_start': {
        if (voice) return { ok: true };
        // The phrase and what followed it, when "Hey Ava" started this; listening pauses either way
        const fresh = wake.takeCapture();
        const next = createVoiceSession(
          { ...(message.options as VoiceOptions | EconomyOptions), preroll: fresh },
          {
            onTurn: (heard, said) => notify({ type: 'voice_turn', heard, said }),
            onTool: (name, args, heard) => chrome.runtime.sendMessage({ type: 'voice_tool', name, args, heard }),
            onStatus: (status, error) => notify({ type: 'voice_status', status, error }),
            onUsage: (inputSeconds, outputSeconds) => notify({ type: 'voice_usage', inputSeconds, outputSeconds }),
          },
        );
        try {
          await next.start();
        } catch (error) {
          next.stop();
          wake.resume();
          return {
            ok: false,
            error: String(error),
            micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
          };
        }
        voice = next;
        return { ok: true };
      }
      case 'voice_stop':
        voice?.stop();
        voice = null;
        wake.resume();
        return { ok: true };
      case 'wake_start':
        try {
          await wake.start();
          if (!voice) wake.resume();
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: String(error),
            micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
          };
        }
      case 'wake_stop':
        wake.stop();
        return { ok: true };
      case 'wake_running':
        return { running: wake.running };
      case 'voice_say':
        voice?.say(String(message.text ?? ''));
        return { ok: voice !== null };
      case 'tts_play': {
        tts ??= new TtsPlayer({
          onEnded: () => notify({ type: 'tts_ended' }),
          onError: error => notify({ type: 'tts_error', error: String(error) }),
        });
        tts.play(String(message.audio ?? ''));
        return { ok: true };
      }
      case 'tts_stop':
        tts?.stop();
        return { ok: true };
      case 'tts_running':
        return { running: tts?.playing() ?? false };
      case 'voice_running':
        return { running: voice !== null };
      case 'recorder_status':
        return { recording: recorder !== null, meetingId: recorder?.options.meetingId ?? null };
      default:
        return { ok: false, error: `Unknown command ${message.type}` };
    }
  })().then(sendResponse);
  return true;
});
