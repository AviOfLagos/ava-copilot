import { OFFSCREEN_CALL_MIC_TARGET } from '../background/call-tasks/wire';
import type { EconomyEngines } from '../background/voice/engines/wire';
import { acquireStt, releaseStt } from './stt/pool';
import { hasWords, UtteranceCollector } from './stt/utterances';

/**
 * Avi's own voice on a call whose notes come from the tab's audio (docs/pm-desk.md, Part 6). The recorder mixes the
 * microphone into the tab's sound, so nothing in it is only his: spoken commands get this stream of their own, with
 * the browser's echo cancellation on, written down by the recogniser on this computer. Nothing leaves the computer;
 * each utterance goes to the background as words, where only a command in them does anything.
 *
 * It runs only while the background asks (a call recording with his microphone), and stops on its own when the
 * recorder stops.
 */

const RATE = 16_000;

interface Running {
  meetingId: string;
  stop: () => void;
}

let running: Running | null = null;
// Keys never repeat, even after this document is made again: the background remembers what each key said
const KEY_BASE = Date.now();
let counter = 0;
// Starts and stops run one at a time, so two starts cannot both open a microphone
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(work: () => Promise<T> | T): Promise<T> => {
  const next = turn.then(work);
  turn = next.catch(() => {});
  return next;
};

function start(meetingId: string, config: EconomyEngines['stt']): Promise<void> {
  return inTurn(() => open(meetingId, config));
}

async function open(meetingId: string, config: EconomyEngines['stt']): Promise<void> {
  if (running?.meetingId === meetingId) return;
  stopNow();
  const engine = await acquireStt(config);
  let mic: MediaStream | null = null;
  let input: AudioContext | null = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    input = new AudioContext({ sampleRate: RATE });
    await input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
  } catch (error) {
    // Nothing is left open when a step fails: the microphone light goes off
    mic?.getTracks().forEach(track => track.stop());
    void input?.close().catch(() => {});
    releaseStt(engine);
    throw error;
  }
  listen(meetingId, engine, mic, input);
}

function listen(
  meetingId: string,
  engine: Awaited<ReturnType<typeof acquireStt>>,
  mic: MediaStream,
  input: AudioContext,
): void {
  const collector = new UtteranceCollector({ sampleRate: RATE, maxMs: 20_000 });
  const node = new AudioWorkletNode(input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
  let stopped = false;
  // One utterance written down at a time, in order
  let queue = Promise.resolve();
  node.port.onmessage = event => {
    const { utterance } = collector.push(event.data as Float32Array);
    if (!utterance || stopped) return;
    const endedAt = Date.now();
    const startedAt = endedAt - Math.round((utterance.length / RATE) * 1000);
    queue = queue.then(async () => {
      if (stopped) return;
      const text = (await engine.transcribe(utterance).catch(() => '')).trim();
      if (stopped || !hasWords(text)) return;
      counter += 1;
      await chrome.runtime
        .sendMessage({
          type: 'meeting_call_speech',
          meetingId,
          key: `mic:${KEY_BASE}-${counter}`,
          text,
          startedAt,
          endedAt,
        })
        .catch(() => {});
    });
  };
  input.createMediaStreamSource(mic).connect(node);
  const mute = input.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(input.destination);

  running = {
    meetingId,
    stop: () => {
      stopped = true;
      node.port.onmessage = null;
      mic.getTracks().forEach(track => track.stop());
      void input.close().catch(() => {});
      releaseStt(engine);
    },
  };
}

function stopNow(meetingId?: string): void {
  if (!running || (meetingId && running.meetingId !== meetingId)) return;
  running.stop();
  running = null;
}

function stop(meetingId?: string): Promise<void> {
  return inTurn(() => stopNow(meetingId));
}

type Message = { target?: string; type?: string; [key: string]: unknown };

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  // The recorder stopping is the call's notes ending: the command stream ends with it (no answer from here)
  if (message?.target === 'offscreen' && message.type === 'recorder_stop') {
    void stop(typeof message.meetingId === 'string' ? message.meetingId : undefined);
    return;
  }
  if (message?.target !== OFFSCREEN_CALL_MIC_TARGET) return;
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const reply = async (): Promise<unknown> => {
    switch (message.type) {
      case 'call_mic_start':
        try {
          await start(String(message.meetingId ?? ''), message.stt as EconomyEngines['stt']);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
          };
        }
      case 'call_mic_stop':
        await stop(typeof message.meetingId === 'string' ? message.meetingId : undefined);
        return { ok: true };
      case 'call_mic_running':
        return { running: running?.meetingId ?? null };
      default:
        return { ok: false, error: `Unknown command ${String(message.type)}` };
    }
  };
  void reply().then(sendResponse, error =>
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
