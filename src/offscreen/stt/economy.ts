import { requestMicStream } from '@extension/shared';
import type { EconomyHistoryItem, EconomyTurnReply, EconomyTurnRequest } from '../../background/voice/engines/protocol';
import type { EconomyEngines } from '../../background/voice/engines/wire';
import { localTts } from '../tts-local/shared';
import { VoiceSession } from '../voice';
import type { TurnImage, VoiceEvents, VoiceOptions, VoiceStatus, VoiceTool } from '../voice';
import type { SttEngine } from './engines';
import { recordHeard } from './listen';
import { acquireStt, releaseStt } from './pool';
import { isRequest, UtteranceCollector } from './utterances';
import { level } from '../vad';
import { SpokenLines } from '../lines';
import type { LineTts } from '../lines';

/**
 * The economy voice conversation: the same Talk button, tools and thread as the Gemini Live one, but no audio
 * leaves the device. The microphone is cut into utterances by the speech gate, a local recogniser writes them
 * down, the background answers with a text model and the voice tools, and a local voice speaks the answer.
 * Talking over the answer stops it at once; the gate closing is the end of the user's turn.
 */

const INPUT_RATE = 16_000;
// Speech over the copilot's answer this long stops the answer (shorter is a cough or an echo). It counts from the
// gate opening, and while the answer plays the gate itself already asks for louder speech held for 300 ms
const BARGE_IN_MS = 400;
// The answer's voice still reaches the microphone a moment after it stops playing
const ECHO_TAIL_MS = 300;
// The quiet that ends an utterance (UtteranceCollector's default)
const UTTERANCE_HANGOVER_MS = 700;
// Exchanges sent with each turn, newest last
const HISTORY_TURNS = 8;
const SORRY = 'Sorry, I could not answer that.';

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
}

export interface EconomyDeps {
  // Starts the microphone at 16 kHz, on the chosen device (null for the system default); returns how to stop it
  openMic: (onChunk: (samples: Float32Array) => void, deviceId: string | null) => Promise<() => void>;
  loadStt: (config: EconomyEngines['stt']) => Promise<SttEngine>;
  releaseStt: () => void;
  // Speaks and resolves once heard, or stopped
  speak: (text: string, tts: EconomyEngines['tts']) => Promise<void>;
  stopSpeaking: (tts: EconomyEngines['tts']) => void;
  warmVoice: (tts: EconomyEngines['tts']) => Promise<void>;
  // The background's answer to one turn
  ask: (request: EconomyTurnRequest) => Promise<EconomyTurnReply>;
}

export class EconomySession {
  private stopped = false;
  private ready = false;
  private closeMic: (() => void) | null = null;
  private stt: SttEngine | null = null;
  private readonly collector = new UtteranceCollector({ sampleRate: INPUT_RATE });
  private readonly history: EconomyHistoryItem[] = [];
  // Utterances waiting to be written down, then words waiting for an answer
  private utterances: Float32Array[] = [];
  private heardQueue: string[] = [];
  private notices: string[] = [];
  // Messages typed in the conversation's chat, with their pictures
  private typedQueue: { text: string; images: TurnImage[]; note: string }[] = [];
  private transcribing = false;
  private thinking = false;
  private speaking = false;
  private bargeSamples = 0;
  // Bumped when the user talks over an answer: an answer still on its way is not spoken
  private interruptions = 0;
  // When the answer's voice last stopped, for its echo tail
  private spokeUntil = 0;
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
      this.deps.releaseStt();
      return;
    }
    this.stt = stt;
    this.closeMic = await this.deps.openMic(samples => this.fromMic(samples), this.options.micDeviceId ?? null);
    if (this.stopped) this.closeMic();
    this.ready = true;
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
    if (this.stt) this.deps.releaseStt();
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
    }
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
      this.utterances.push(utterance);
      void this.transcribeNext();
    }
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
    const audio = this.utterances.shift();
    if (!audio) return;
    this.transcribing = true;
    try {
      const started = performance.now();
      const text = (await this.stt.transcribe(audio)).trim();
      // Noise the recogniser turned into "you" or "thank you" is not a question: answering it would make the
      // copilot talk on its own and keep the conversation from ever going idle
      if (!this.stopped && isRequest(text)) {
        recordHeard(text, Math.round(performance.now() - started));
        this.heardQueue.push(text);
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
    if (this.heardQueue.length) {
      // Words that came while the copilot was busy are one turn together
      const heard = this.heardQueue.splice(0).join(' ');
      void this.turn({ heard });
      return;
    }
    const quiet = !this.transcribing && !this.collector.speaking && !this.utterances.length;
    if (this.lines.waiting && quiet) {
      void this.sayLine();
      return;
    }
    if (this.notices.length && quiet) {
      void this.turn({ notice: this.notices.splice(0).join('\n') });
    }
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
      reply = await this.deps.ask({
        type: 'voice_engine_turn',
        ...input,
        ...(input.images?.length ? {} : { images: undefined, note: undefined }),
        history: this.history.slice(-HISTORY_TURNS),
        instructions: this.options.instructions,
        tools: this.options.tools,
      });
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
        await this.deps.speak(said, this.options.economy.tts);
      } catch (error) {
        if (!this.stopped) this.status('listening', `The voice failed: ${String(error)}`);
      }
      // Already false when the user talked over it
      if (this.speaking) this.spokeUntil = performance.now();
      this.speaking = false;
      this.bargeSamples = 0;
      if (this.stopped) return;
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
