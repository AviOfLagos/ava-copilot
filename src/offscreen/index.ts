import { Recorder } from './recorder';
import type { RecorderOptions } from './recorder';
import type { VoiceOptions } from './voice';
import { WakeListener } from './wake';
import { TtsPlayer } from './tts';
import { createVoiceSession } from './stt/economy';
import type { AnyVoiceSession, EconomyOptions } from './stt/economy';
import { enumerateAudioDevices } from './devices';
import { localTts } from './tts-local/shared';
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

// The chosen microphone/speaker (Settings › Voice devices), kept here rather than read from
// @extension/storage directly: importing a settings store from this entrypoint changes its chunk
// graph in a way that has broken message delivery in testing, so the background reads the store
// instead and pushes the values over with 'audio_devices_apply' (see src/background/offscreen.ts,
// which pushes once right after creating this document, and src/background/audio-devices/register.ts,
// which pushes again on every later change). Applied immediately to whatever is running, and used
// as the default for anything this document starts afterwards.
let currentMicId: string | null = null;
let currentSpeakerId: string | null = null;

function applyAudioDeviceSettings(micId: string | null, speakerId: string | null): void {
  currentMicId = micId;
  currentSpeakerId = speakerId;
  void wake.switchMic(micId);
  if (voice && 'switchMic' in voice) void voice.switchMic(micId);
  if (voice && 'switchSpeaker' in voice) voice.switchSpeaker(speakerId);
  localTts().setOutputDevice(speakerId);
  tts?.setOutputDevice(speakerId);
}

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
        const next = new Recorder({ ...(message.options as RecorderOptions), micDeviceId: currentMicId }, notify);
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
        // The chat that keeps this conversation, told with every status so any panel can open it
        const threadId = typeof message.options?.threadId === 'string' ? message.options.threadId : null;
        const next = createVoiceSession(
          {
            ...(message.options as VoiceOptions | EconomyOptions),
            preroll: fresh,
            micDeviceId: currentMicId,
            speakerDeviceId: currentSpeakerId,
          },
          {
            onTurn: (heard, said) => notify({ type: 'voice_turn', heard, said }),
            onTool: (name, args, heard) => chrome.runtime.sendMessage({ type: 'voice_tool', name, args, heard }),
            onStatus: (status, error) => notify({ type: 'voice_status', status, error, threadId }),
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
          const words = Array.isArray(message.words) ? message.words.map(String) : undefined;
          // A new assistant name: listen again for its phrase
          if (wake.running && words && words.join(' ') !== wake.words.join(' ')) wake.stop();
          await wake.start(words, currentMicId);
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
      case 'voice_text': {
        // Typed in the conversation's chat, with any pictures: the user's next turn
        const images = Array.isArray(message.images)
          ? message.images
              .filter(
                (image: { mediaType?: unknown; data?: unknown }) =>
                  typeof image?.mediaType === 'string' && typeof image?.data === 'string',
              )
              .map((image: { mediaType: string; data: string }) => ({ mediaType: image.mediaType, data: image.data }))
          : [];
        if (!voice) return { ok: false };
        voice.sendText(String(message.text ?? ''), images, String(message.note ?? ''));
        return { ok: true };
      }
      case 'tts_play': {
        if (!tts) {
          tts = new TtsPlayer({
            onEnded: () => notify({ type: 'tts_ended' }),
            onError: error => notify({ type: 'tts_error', error: String(error) }),
          });
          tts.setOutputDevice(currentSpeakerId);
        }
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
      case 'audio_devices_list':
        return { devices: await enumerateAudioDevices() };
      case 'audio_devices_apply': {
        const micId = typeof message.micDeviceId === 'string' ? message.micDeviceId : null;
        const speakerId = typeof message.speakerDeviceId === 'string' ? message.speakerDeviceId : null;
        applyAudioDeviceSettings(micId, speakerId);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown command ${message.type}` };
    }
  })().then(sendResponse);
  return true;
});
