import { requestMicStream } from '@extension/shared';
import type { EconomyHistoryItem, EconomyTurnReply, EconomyTurnRequest } from '../../background/voice/engines/protocol';
import type { EconomyEngines } from '../../background/voice/engines/wire';
import { localTts } from '../tts-local/shared';
import { VoiceSession } from '../voice';
import type { TurnImage, VoiceEvents, VoiceOptions, VoiceStatus, VoiceTool } from '../voice';
import type { SttEngine } from './engines';
import { recordHeard } from './listen';
import { acquireStt, releaseStt } from './pool';
import { isRequest, speechLevel, UtteranceCollector } from './utterances';
import { Addressee, callWords, soundsUnfinished, UNFINISHED_WAIT_MS } from './addressed';
import type { HeardFragment, SpeakerLabel } from './addressed';
import { level } from '../vad';
import { SpokenLines } from '../lines';
import type { LineTts } from '../lines';

/**
 * The economy voice conversation: the same Talk button, tools and thread as the Gemini Live one, but no audio
 * leaves the device. The microphone is cut into utterances by the speech gate, a local recogniser writes them
 * down, the background answers with a text model and the voice tools, and a local voice speaks the answer.
 * Talking over the answer stops it at once. A turn ends after a pause long enough to be the end of a thought, not a
 * breath (longer when the words stop mid-clause), and only words meant for the copilot are answered (addressed.ts).
 */

const INPUT_RATE = 16_000;
// Speech over the copilot's answer this long stops the answer (shorter is a cough or an echo). It counts from the
// gate opening, and while the answer plays the gate itself already asks for louder speech held for 300 ms
const BARGE_IN_MS = 400;
// The answer's voice still reaches the microphone a moment after it stops playing
const ECHO_TAIL_MS = 300;
// The quiet that ends an utterance. People pause 0.5–1.5 s mid-sentence to think: at 700 ms one sentence became
// a turn every 1–3 s, each answered, and each too short for the recogniser to get right (issue #24)
export const UTTERANCE_HANGOVER_MS = 1200;
// Exchanges sent with each turn, newest last
const HISTORY_TURNS = 8;
const SORRY = 'Sorry, I could not answer that.';
// The longest one turn may take (the model, and any tool it calls) before the conversation gives up on it and
// listens again. The background stops its own model call a little sooner (voice/engines/economy.ts)
export const TURN_LIMIT_MS = 120_000;
export const TURN_TOO_LONG = 'That took too long, so I stopped. Ask me again.';
// Ending the conversation while a transcription has been running this long means the recogniser is stuck: it is
// thrown away so the next conversation starts with a fresh one
const STUCK_TRANSCRIBE_MS = 8_000;

/** Resolves with `fallback` if `work` takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** About how long saying `text` takes, with room to spare: past it, the voice is taken as stuck. */
export function speakLimitMs(text: string): number {
  return 20_000 + text.length * 120;
}

export interface EconomyOptions {
  mode: 'economy';
  instructions: string;
  tools: VoiceTool[];
  // What followed "Hey Ava", when the wake word started this: the start of the first utterance
  preroll?: Float32Array[];
  economy: EconomyEngines;
  // The chosen microphone/speaker (Settings › Voice devices), or null for the system default
  micDeviceId?: string | null;
  speakerDeviceId?: string | null;
  // What the user calls the copilot (Settings › General): after a lull, only words with it are answered
  assistantName?: string;
}

export interface EconomyDeps {
  // Starts the microphone at 16 kHz, on the chosen device (null for the system default); returns how to stop it
  openMic: (onChunk: (samples: Float32Array) => void, deviceId: string | null) => Promise<() => void>;
  loadStt: (config: EconomyEngines['stt']) => Promise<SttEngine>;
  releaseStt: (engine?: SttEngine) => void;
  // Speaks and resolves once heard, or stopped
  speak: (text: string, tts: EconomyEngines['tts']) => Promise<void>;
  stopSpeaking: (tts: EconomyEngines['tts']) => void;
  warmVoice: (tts: EconomyEngines['tts']) => Promise<void>;
  // The background's answer to one turn
  ask: (request: EconomyTurnRequest) => Promise<EconomyTurnReply>;
  // Whose voice an utterance is: the seam for voiceprints (Ambient A2). Without it every voice is 'unknown'
  whoSpoke?: (audio: Float32Array) => Promise<SpeakerLabel>;
}

export class EconomySession {
  private stopped = false;
  private ready = false;
  private closeMic: (() => void) | null = null;
  private stt: SttEngine | null = null;
  private readonly collector = new UtteranceCollector({ sampleRate: INPUT_RATE, hangoverMs: UTTERANCE_HANGOVER_MS });
  private readonly history: EconomyHistoryItem[] = [];
  // Utterances waiting to be written down (with when their speech started), then words waiting to be one turn
  private utterances: { audio: Float32Array; startedAt: number }[] = [];
  private heardQueue: HeardFragment[] = [];
  // Whether words are meant for the copilot, and what calls it
  private readonly names: string[];
  private readonly addressee: Addressee;
  private speechStartedAt = 0;
  // Microphone samples since the speech gate last closed: how long the user has been quiet past the hangover
  private quietSamples = 0;
  private notices: string[] = [];
  // Messages typed in the conversation's chat, with their pictures
  private typedQueue: { text: string; images: TurnImage[]; note: string }[] = [];
  private transcribing = false;
  private transcribeStartedAt = 0;
  private thinking = false;
  private speaking = false;
  private bargeSamples = 0;
  // Bumped when the user talks over an answer: an answer still on its way is not spoken
  private interruptions = 0;
  // When the answer's voice last stopped, for its echo tail. Never, at first: 0 would put the first 300 ms of a
  // fresh document (performance.now() starts near 0) in an echo tail, and the user's first words would need to be
  // as loud as talking over the copilot
  private spokeUntil = Number.NEGATIVE_INFINITY;
  // The utterance being collected was heard over the answer, and whether it stopped the answer: one that did
  // not is the answer's own echo (or noise under it), never a turn
  private overPlayback = false;
  private bargedIn = false;
  // Dictation in the chat box has the microphone: nothing heard here counts meanwhile
  private micHeld = false;
  // An agent's lines, said in its own voice with the same engine (see SpokenLines)
  private readonly lines: SpokenLines;
  // The voice the line playing now uses, so talking over it stops the right engine
  private lineTts: LineTts | null = null;

  constructor(
    private readonly options: EconomyOptions,
    private readonly events: VoiceEvents,
    private readonly deps: EconomyDeps = browserDeps(),
  ) {
    this.names = callWords(options.assistantName);
    this.addressee = new Addressee(this.names, performance.now());
    this.lines = new SpokenLines({
      speak: (text, tts) => this.deps.speak(text, tts),
      stop: tts => this.deps.stopSpeaking(tts),
    });
  }

  /** A line someone else says (an agent's answer, its name first), in its voice, once the copilot is free. */
  speakAs(text: string, tts: LineTts): void {
    if (!text.trim()) return;
    this.lines.push({ text: text.slice(0, 4000), tts });
    this.pump();
  }

  /** The conversation's personality changed: its instructions now, its voice from the next answer. */
  reconfigure(changes: { instructions?: string; tts?: LineTts }, notice = ''): void {
    if (changes.instructions) this.options.instructions = changes.instructions;
    if (changes.tts) {
      this.options.economy = { ...this.options.economy, tts: changes.tts };
      void this.deps.warmVoice(changes.tts).catch(() => {});
    }
    if (notice) this.say(notice);
  }

  async start(): Promise<void> {
    this.status('connecting');
    // The voice loads while the recogniser does; an answer waits for it either way
    void this.deps.warmVoice(this.options.economy.tts).catch(() => {});
    const stt = await this.deps.loadStt(this.options.economy.stt);
    // Ended while the recogniser loaded: it goes back at once
    if (this.stopped) {
      this.deps.releaseStt(stt);
      return;
    }
    this.stt = stt;
    this.closeMic = await this.deps.openMic(samples => this.fromMic(samples), this.options.micDeviceId ?? null);
    if (this.stopped) this.closeMic();
    this.ready = true;
    // Starting the conversation is talking to the copilot: the lull counts from now
    this.addressee.exchanged(performance.now());
    this.speechStartedAt = performance.now();
    this.collector.seed(this.options.preroll?.splice(0) ?? []);
    this.status('listening');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.closeMic?.();
    this.closeMic = null;
    if (this.speaking) this.deps.stopSpeaking(this.lineTts ?? this.options.economy.tts);
    this.lines.stop();
    // A transcription still running long after it should have finished: the recogniser is stuck, and the pool would
    // hand the same stuck engine to the next conversation
    if (this.stt && this.transcribing && performance.now() - this.transcribeStartedAt > STUCK_TRANSCRIBE_MS) {
      this.stt.dispose();
    }
    if (this.stt) this.deps.releaseStt(this.stt);
    this.stt = null;
    this.events.onStatus('off');
  }

  /** Something for the copilot to tell the user, said once it is free. */
  say(notice: string): void {
    if (!notice.trim()) return;
    this.notices.push(notice);
    this.pump();
  }

  /** A message the user typed in the conversation's chat: the next turn, before anything heard after it. */
  sendText(text: string, images: TurnImage[] = [], note = ''): void {
    if (!text.trim() && images.length === 0) return;
    // Typing over the answer stops it, as talking over it does
    if (this.speaking) this.interrupt();
    this.addressee.exchanged(performance.now());
    this.typedQueue.push({ text: text.slice(0, 4000), images, note });
    this.pump();
  }

  /** Holds the microphone (dictation in the chat box has it) or gives it back; typed turns still work. */
  holdMic(on: boolean): void {
    if (this.micHeld === on) return;
    this.micHeld = on;
    if (on) {
      this.collector.cancel();
      this.bargeSamples = 0;
      this.overPlayback = false;
      this.bargedIn = false;
      // Words already heard are the whole turn: nothing more comes while the microphone is held
      this.quietSamples = Number.POSITIVE_INFINITY;
      this.pump();
    }
  }

  /** The answer's voice can be heard now (or was a moment ago). */
  private audible(): boolean {
    return this.speaking || performance.now() - this.spokeUntil < ECHO_TAIL_MS;
  }

  private fromMic(samples: Float32Array): void {
    if (!this.ready || this.stopped || this.micHeld) return;
    const playing = this.audible();
    const { speechStarted, utterance } = this.collector.push(samples, { playing });
    if (speechStarted) {
      this.overPlayback = this.speaking;
      this.bargedIn = false;
      this.speechStartedAt = performance.now();
    }
    this.quietSamples = this.collector.speaking ? 0 : this.quietSamples + samples.length;
    if (this.speaking && this.collector.speaking) {
      this.overPlayback = true;
      // Only loud audio counts toward a barge-in, not the quiet the gate lets through after it
      if (level(samples) > this.collector.threshold(true)) this.bargeSamples += samples.length;
      if (this.bargeSamples >= (BARGE_IN_MS / 1000) * INPUT_RATE) {
        this.bargedIn = true;
        this.interrupt();
      }
    } else {
      this.bargeSamples = 0;
    }
    if (utterance) {
      // The last loud sound was one hangover ago: if that was while the answer could still be heard, all of it was
      const lastLoud = performance.now() - UTTERANCE_HANGOVER_MS;
      const echo = this.overPlayback && !this.bargedIn && (this.speaking || lastLoud <= this.spokeUntil + ECHO_TAIL_MS);
      this.overPlayback = false;
      this.bargedIn = false;
      // Heard over the answer without stopping it: the answer's own echo, dropped so it is never answered
      if (echo) return;
      this.utterances.push({ audio: utterance, startedAt: this.speechStartedAt });
      void this.transcribeNext();
    }
    // Words waiting for the rest of the sentence: this quiet may be long enough now
    if (this.heardQueue.length) this.pump();
  }

  /** The user talked over the answer: it stops now, and what they say next is the next turn. */
  private interrupt(): void {
    this.bargeSamples = 0;
    this.interruptions++;
    this.speaking = false;
    this.spokeUntil = performance.now();
    this.deps.stopSpeaking(this.lineTts ?? this.options.economy.tts);
    this.status('listening');
  }

  private async transcribeNext(): Promise<void> {
    if (this.transcribing || !this.stt) return;
    const next = this.utterances.shift();
    if (!next) return;
    const { audio, startedAt } = next;
    this.transcribing = true;
    this.transcribeStartedAt = performance.now();
    try {
      const started = performance.now();
      const [said, speaker] = await Promise.all([this.stt.transcribe(audio, this.options.economy.stt.language), this.whoSpoke(audio)]);
      const text = said.trim();
      // Noise the recogniser turned into "you" or "thank you" is not a question: answering it would make the
      // copilot talk on its own and keep the conversation from ever going idle
      if (!this.stopped && isRequest(text)) {
        recordHeard(text, Math.round(performance.now() - started));
        this.heardQueue.push({ text, level: speechLevel(audio, INPUT_RATE), startedAt, speaker });
      }
    } catch (error) {
      if (!this.stopped) this.status('listening', `Speech recognition failed: ${String(error)}`);
    } finally {
      this.transcribing = false;
    }
    this.pump();
    if (this.utterances.length) void this.transcribeNext();
  }

  /** Starts the next turn when nothing else is going on: the user's words first, then notices. */
  private pump(): void {
    if (this.stopped || !this.ready || this.thinking || this.speaking) return;
    const typed = this.typedQueue.shift();
    if (typed) {
      void this.turn({ heard: typed.text, typed: true, images: typed.images, note: typed.note });
      return;
    }
    if (this.heardQueue.length && this.turnOver()) {
      // Fragments of one sentence, and words that came while the copilot was busy, are one turn together
      const fragments = this.heardQueue.splice(0);
      // Not meant for the copilot (a radio, someone across the room, talk after a lull without its name): dropped
      if (this.addressee.judge(fragments, performance.now()).ok) {
        void this.turn({ heard: fragments.map(fragment => fragment.text).join(' ') });
        return;
      }
    }
    const quiet = !this.transcribing && !this.collector.speaking && !this.utterances.length && !this.heardQueue.length;
    if (this.lines.waiting && quiet) {
      void this.sayLine();
      return;
    }
    if (this.notices.length && quiet) {
      void this.turn({ notice: this.notices.splice(0).join('\n') });
    }
  }

  /**
   * Whether the user has finished: not talking, nothing left to write down, and quiet for long enough. The gate's
   * hangover is enough after a finished sentence; words that stop mid-clause wait a second longer for the rest.
   */
  private turnOver(): boolean {
    if (this.collector.speaking || this.transcribing || this.utterances.length) return false;
    const words = this.heardQueue.map(fragment => fragment.text).join(' ');
    if (!soundsUnfinished(words, this.names)) return true;
    return this.quietSamples >= (UNFINISHED_WAIT_MS / 1000) * INPUT_RATE;
  }

  /** Whose voice this is, when voiceprints can tell; a failure is no answer. */
  private async whoSpoke(audio: Float32Array): Promise<SpeakerLabel> {
    if (!this.deps.whoSpoke) return 'unknown';
    return this.deps.whoSpoke(audio).catch(() => 'unknown' as const);
  }

  /** Says the next agent line in its own voice; talking over it stops it, as with an answer. */
  private async sayLine(): Promise<void> {
    this.speaking = true;
    this.status('speaking');
    const line = await this.lines.next(true, started => {
      this.lineTts = started.tts;
    });
    this.lineTts = null;
    if (line)
      this.history.push({ heard: 'An agent spoke to the user in its own voice.', said: line.text, notice: true });
    if (this.speaking) this.spokeUntil = performance.now();
    this.speaking = false;
    this.bargeSamples = 0;
    if (this.stopped) return;
    this.addressee.exchanged(performance.now());
    this.status('listening');
    this.pump();
  }

  private async turn(input: {
    heard?: string;
    notice?: string;
    typed?: boolean;
    images?: TurnImage[];
    note?: string;
  }): Promise<void> {
    this.thinking = true;
    const interruptions = this.interruptions;
    let reply: EconomyTurnReply;
    try {
      // A turn that never comes back would keep the conversation from ever hearing anything again
      reply = await within(
        this.deps.ask({
          type: 'voice_engine_turn',
          ...input,
          ...(input.images?.length ? {} : { images: undefined, note: undefined }),
          history: this.history.slice(-HISTORY_TURNS),
          instructions: this.options.instructions,
          tools: this.options.tools,
        }),
        TURN_LIMIT_MS,
        () => ({ said: TURN_TOO_LONG, error: TURN_TOO_LONG }),
      );
    } catch (error) {
      reply = { said: '', error: error instanceof Error ? error.message : String(error) };
    }
    this.thinking = false;
    if (this.stopped) return;
    const heard = input.heard ?? '';
    // A failed turn still answers, so the user is not left waiting; the reason shows on screen
    const said = reply.said.trim() || (reply.error && heard ? SORRY : '');
    if (reply.error) this.status('listening', reply.error);
    this.history.push(
      input.notice
        ? { heard: input.notice.slice(0, 4000), said: said.slice(0, 4000), notice: true }
        : { heard: heard.slice(0, 4000), said: said.slice(0, 4000) },
    );
    // A typed message is in the chat already: only the answer is added
    if (input.typed) {
      if (said) this.events.onTurn('', said);
    } else if (heard || said) this.events.onTurn(heard, said);
    // The user went on talking while this was being answered: their newer words come first
    const overtaken =
      this.heardQueue.length > 0 ||
      this.typedQueue.length > 0 ||
      this.interruptions !== interruptions ||
      this.collector.speaking;
    if (said && !reply.ended && !overtaken) {
      this.speaking = true;
      this.status('speaking');
      try {
        // A voice that never finishes would keep the conversation from listening again
        await within(this.deps.speak(said, this.options.economy.tts), speakLimitMs(said), () => {
          this.deps.stopSpeaking(this.options.economy.tts);
        });
      } catch (error) {
        if (!this.stopped) this.status('listening', `The voice failed: ${String(error)}`);
      }
      // Already false when the user talked over it
      if (this.speaking) this.spokeUntil = performance.now();
      this.speaking = false;
      this.bargeSamples = 0;
      if (this.stopped) return;
      // The copilot just spoke: what the user says back needs no name
      this.addressee.exchanged(performance.now());
      this.status('listening');
    }
    this.pump();
  }

  /** Reports how the conversation is going, but never after it ended. */
  private status(status: VoiceStatus, error?: string): void {
    if (this.stopped && status !== 'off') return;
    this.events.onStatus(status, error);
  }
}

/** The real microphone, recogniser, voices and background. */
function browserDeps(): EconomyDeps {
  return {
    openMic: async (onChunk, deviceId) => {
      const mic = await requestMicStream(navigator.mediaDevices, deviceId, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      const input = new AudioContext({ sampleRate: INPUT_RATE });
      try {
        await input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
      } catch (error) {
        mic.getTracks().forEach(track => track.stop());
        void input.close();
        throw error;
      }
      const node = new AudioWorkletNode(input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = event => onChunk(event.data as Float32Array);
      input.createMediaStreamSource(mic).connect(node);
      const mute = input.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(input.destination);
      return () => {
        mic.getTracks().forEach(track => track.stop());
        void input.close().catch(() => {});
      };
    },
    loadStt: config => acquireStt(config),
    releaseStt,
    speak: async (text, tts) => {
      if (tts.engine === 'system') {
        const reply = (await chrome.runtime.sendMessage({
          type: 'voice_engine_system_say',
          text,
          rate: tts.rate,
          ...(tts.voice ? { voice: tts.voice } : {}),
        })) as { ok?: boolean; error?: string } | undefined;
        if (reply?.error) throw new Error(reply.error);
        return;
      }
      await localTts().speak({ engine: tts.engine, text, voice: tts.voice, rate: tts.rate });
    },
    stopSpeaking: tts => {
      if (tts.engine === 'system')
        void chrome.runtime.sendMessage({ type: 'voice_engine_system_stop' }).catch(() => {});
      else localTts().stop();
    },
    warmVoice: tts => (tts.engine === 'system' ? Promise.resolve() : localTts().warm(tts.engine)),
    ask: async request => {
      const reply = (await chrome.runtime.sendMessage(request)) as EconomyTurnReply | undefined;
      return reply ?? { said: '', error: 'The background did not answer.' };
    },
  };
}

/** The conversation for these options: economy when asked for, else Gemini Live. */
export function createVoiceSession(
  options: VoiceOptions | EconomyOptions,
  events: VoiceEvents,
): VoiceSession | EconomySession {
  if ((options as { mode?: string }).mode === 'economy') return new EconomySession(options as EconomyOptions, events);
  return new VoiceSession(options as VoiceOptions, events);
}

export type AnyVoiceSession = VoiceSession | EconomySession;
