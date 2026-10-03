import { Recorder } from './recorder';
import type { RecorderOptions } from './recorder';

/**
 * The offscreen document holds the meeting's media streams, which a service worker cannot.
 * It takes commands from the background and reports back to it.
 */
let recorder: Recorder | null = null;

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
      case 'recorder_status':
        return { recording: recorder !== null, meetingId: recorder?.options.meetingId ?? null };
      default:
        return { ok: false, error: `Unknown command ${message.type}` };
    }
  })().then(sendResponse);
  return true;
});
