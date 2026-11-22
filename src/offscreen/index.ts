import { Recorder } from './recorder';
import type { RecorderOptions } from './recorder';
import type { VoiceOptions } from './voice';
import { WakeListener } from './wake';
import { TtsPlayer } from './tts';
import { createVoiceSession } from './stt/economy';
import type { AnyVoiceSession, EconomyOptions } from './stt/economy';
import { enumerateAudioDevices } from './devices';
import { measureMic, playTestTone } from './audio-check';
import { localTts } from './tts-local/shared';
import './tts-local/register';
// The call's own microphone stream for spoken commands (docs/pm-desk.md, Part 6)
import './call-mic';
import type { LineTts } from './lines';
import { AmbientListener } from './ambient/listener';
import type { AmbientConfig } from './ambient/listener';

const STT_ENGINES = new Set(['moonshine', 'whisper', 'vosk']);
const STT_MODELS = new Set(['moonshine-tiny', 'moonshine-base', 'whisper-base']);

/** A local recogniser choice, checked: never anything but an engine and model that run on this device. */
function sttChoiceOf(value: unknown): AmbientConfig['stt'] | null {
  const stt = value as { engine?: unknown; model?: unknown; webgpu?: unknown; language?: unknown } | null | undefined;
  if (typeof stt?.engine !== 'string' || !STT_ENGINES.has(stt.engine)) return null;
  const model = typeof stt.model === 'string' && STT_MODELS.has(stt.model) ? stt.model : undefined;
  return {
    engine: stt.engine as AmbientConfig['stt']['engine'],
    ...(model ? { model: model as AmbientConfig['stt']['model'] } : {}),
    webgpu: stt.webgpu === true,
    ...(typeof stt.language === 'string' ? { language: stt.language } : {}),
  };
}

/** Ambient listening's settings from the background, checked. */
function ambientConfigOf(value: unknown): AmbientConfig | null {
  const config = value as { stt?: unknown; lowPowerStt?: unknown; offRecord?: unknown; nameWords?: unknown } | null;
  const stt = sttChoiceOf(config?.stt);
  if (!stt) return null;
  return {
    stt,
    lowPowerStt: sttChoiceOf(config?.lowPowerStt) ?? stt,
    offRecord: config?.offRecord === true,
    nameWords: Array.isArray(config?.nameWords) ? config.nameWords.map(String).slice(0, 4) : ['ava'],
  };
}

/** A voice for a line, checked: an engine and a voice name, a pace within reason. */
function lineTtsOf(value: unknown): LineTts | null {
  const tts = value as { engine?: unknown; voice?: unknown; rate?: unknown } | null | undefined;
  if (tts?.engine !== 'kitten' && tts?.engine !== 'kokoro' && tts?.engine !== 'system') return null;
  const rate = typeof tts.rate === 'number' && tts.rate >= 0.5 && tts.rate <= 2 ? tts.rate : 1;
  return { engine: tts.engine, voice: typeof tts.voice === 'string' ? tts.voice.slice(0, 200) : '', rate };
}

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
// Ambient listening: what is said around the Mac, written down here and sent to the background as text
const ambient = new AmbientListener(event => notify(event));

// The chosen microphone/speaker (Settings › Voice devices), kept here rather than read from
// @extension/storage directly: importing a settings store from this entrypoint changes its chunk
// graph in a way that has broken message delivery in testing, so the background reads the store
// instead and pushes the values over with 'audio_devices_apply' (see src/background/offscreen.ts,
// which pushes once right after creating this document, and src/background/audio-devices/register.ts,
// which pushes again on every later change). Applied immediately to whatever is running, and used
// as the default for anything this document starts afterwards.
let currentMicId: string | null = null;
let currentSpeakerId: string | null = null;

// Dictation in the side panel's chat box has the microphone: the conversation hears nothing and "Hey Ava" is not
// listened for. Given back when dictation ends, or after this long whatever happens (a panel that closed mid-way)
const DICTATION_HOLD_MAX_MS = 3 * 60 * 1000;
let dictationHeld = false;
let dictationTimer: ReturnType<typeof setTimeout> | null = null;

function holdForDictation(on: boolean): void {
  if (dictationTimer) clearTimeout(dictationTimer);
  dictationTimer = on ? setTimeout(() => holdForDictation(false), DICTATION_HOLD_MAX_MS) : null;
  dictationHeld = on;
  voice?.holdMic(on);
  wake.hold(on);
  if (on) ambient.pause('dictation');
  else ambient.resume('dictation');
}

function applyAudioDeviceSettings(micId: string | null, speakerId: string | null): void {
  currentMicId = micId;
  currentSpeakerId = speakerId;
  void wake.switchMic(micId);
  void ambient.switchMic(micId).catch(() => {});
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
        // The meeting's own notes take over; ambient listening waits until it ends
        ambient.pause('recorder');
        return { ok: true, micUsed: next.micUsed };
      }
      case 'recorder_stop': {
        const current = recorder;
        recorder = null;
        if (!current || current.options.meetingId !== message.meetingId) {
          return { ok: false, error: 'Not recording this meeting' };
        }
        await current.stop();
        ambient.resume('recorder');
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
        // Known at once, so a second start (or the minute check of the wake word) sees a conversation on
        voice = next;
        // A conversation is not ambient talk: listening waits until it ends
        ambient.pause('voice');
        if (dictationHeld) next.holdMic(true);
        try {
          await next.start();
        } catch (error) {
          next.stop();
          if (voice === next) voice = null;
          wake.resume();
          ambient.resume('voice');
          return {
            ok: false,
            error: String(error),
            micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
          };
        }
        // Ended while it started: voice_stop already closed it, and the background undoes the rest
        return { ok: true };
      }
      case 'voice_stop':
        voice?.stop();
        voice = null;
        wake.resume();
        ambient.resume('voice');
        return { ok: true };
      // Ambient listening started, or its settings changed (off the record, the recogniser, the name)
      case 'ambient_start': {
        const config = ambientConfigOf(message.config);
        if (!config) return { ok: false, error: 'No speech recogniser on this device' };
        if (voice) ambient.pause('voice');
        if (recorder) ambient.pause('recorder');
        if (dictationHeld) ambient.pause('dictation');
        try {
          await ambient.start(config, currentMicId);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: String(error),
            micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
          };
        }
      }
      case 'ambient_stop':
        ambient.stop();
        return { ok: true };
      case 'ambient_running':
        return { running: ambient.running, offRecord: ambient.offRecord };
      case 'wake_start':
        try {
          const words = Array.isArray(message.words) ? message.words.map(String) : undefined;
          // A new assistant name: listen again for its phrase
          if (wake.running && words && words.join(' ') !== wake.words.join(' ')) wake.stop();
          await wake.start(words, currentMicId);
          // Only a listener left paused with nothing in hand: never a wake that is starting a conversation
          if (!voice) wake.resumeIfIdle();
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
      // Dictation in the chat box started or ended (see holdForDictation)
      case 'dictation_hold':
        holdForDictation(message.on === true);
        return { ok: true };
      case 'voice_mic_hold':
        voice?.holdMic(message.on === true);
        return { ok: voice !== null };
      case 'wake_pause':
        wake.hold(message.on === true);
        return { ok: true };
      case 'wake_running':
        return { running: wake.running };
      case 'voice_say':
        voice?.say(String(message.text ?? ''));
        return { ok: voice !== null };
      // An agent's line, in its own voice on the device (see SpokenLines)
      case 'voice_speak_as': {
        const tts = lineTtsOf(message.tts);
        if (!voice || !tts) return { ok: false };
        voice.speakAs(String(message.text ?? '').slice(0, 4000), tts);
        return { ok: true };
      }
      // The conversation's personality changed: its voice and instructions
      case 'voice_reconfigure': {
        if (!voice) return { ok: false };
        const instructions = typeof message.instructions === 'string' ? message.instructions : undefined;
        const notice = typeof message.notice === 'string' ? message.notice.slice(0, 2000) : '';
        if ('sendImage' in voice) {
          voice.reconfigure(
            { instructions, speechConfig: message.speechConfig as VoiceOptions['speechConfig'] },
            notice,
          );
        } else {
          const tts = lineTtsOf(message.economyTts);
          voice.reconfigure({ instructions, ...(tts ? { tts } : {}) }, notice);
        }
        return { ok: true };
      }
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
      case 'voice_image': {
        // The screen, for read_screen: only a Gemini Live session can look at it
        const image = message.image as { mediaType?: unknown; data?: unknown } | undefined;
        if (
          !voice ||
          !('sendImage' in voice) ||
          typeof image?.mediaType !== 'string' ||
          typeof image.data !== 'string'
        ) {
          return { ok: false };
        }
        return { ok: voice.sendImage({ mediaType: image.mediaType, data: image.data }) };
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
      // check_audio: the chosen mic's level over ~2 s, and a test tone on the chosen speaker
      case 'audio_check_mic':
        // The background names the device: a fresh document may not have had the choice pushed yet
        return measureMic(
          typeof message.micDeviceId === 'string' ? message.micDeviceId : currentMicId,
          typeof message.durationMs === 'number' ? Math.min(message.durationMs, 5000) : 2000,
        );
      case 'audio_check_tone':
        return playTestTone(typeof message.speakerDeviceId === 'string' ? message.speakerDeviceId : currentSpeakerId);
      // What the user is looking at now, as quiet context for the conversation (never a turn of its own)
      case 'voice_context':
        if (!voice || !('addContext' in voice)) return { ok: false };
        voice.addContext(String(message.text ?? '').slice(0, 1000));
        return { ok: true };
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
  })().then(sendResponse, error =>
    // A command that throws still answers: a promised reply that never comes reaches the background as Chrome's
    // "message channel closed before a response was received"
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
