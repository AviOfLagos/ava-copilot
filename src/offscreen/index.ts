import { Recorder } from './recorder';
import type { RecorderOptions } from './recorder';
import { VoiceSession } from './voice';
import type { VoiceOptions } from './voice';

/**
 * The offscreen document holds the meeting's media streams, which a service worker cannot.
 * It takes commands from the background and reports back to it.
 */
let recorder: Recorder | null = null;
let voice: VoiceSession | null = null;

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
        const next = new VoiceSession(message.options as VoiceOptions, {
          onTurn: (heard, said) => notify({ type: 'voice_turn', heard, said }),
          onTool: (name, args) => chrome.runtime.sendMessage({ type: 'voice_tool', name, args }),
          onStatus: (status, error) => notify({ type: 'voice_status', status, error }),
          onUsage: (inputSeconds, outputSeconds) => notify({ type: 'voice_usage', inputSeconds, outputSeconds }),
        });
        try {
          await next.start();
        } catch (error) {
          next.stop();
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
        return { ok: true };
      case 'voice_say':
        voice?.say(String(message.text ?? ''));
        return { ok: voice !== null };
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
