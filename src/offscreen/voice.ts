import { pcm16Base64 } from './live';
import { SpeechGate } from './vad';
import { TurnTaking } from './turns';
import { liveSocketUrl } from './liveAuth';
import type { LiveOptions } from './live';
import { requestMicStream, setAudioSinkId } from '@extension/shared';

/**
 * A spoken conversation with the copilot over the Gemini Live API: the microphone goes up, the
 * model's voice comes back and plays. The model works through tools, which the background runs.
 * It can be told things to say (a task finished, a send waits for Confirm), and it never approves
 * anything: approval stays a click.
 */

export type VoiceStatus = 'connecting' | 'listening' | 'speaking' | 'off';

export const OUTPUT_RATE = 24_000;
const INPUT_RATE = 16_000;
// The copilot's voice still reaches the microphone a moment after the last sample is scheduled (output latency, room)
const ECHO_TAIL_MS = 200;
// How often held notices and the "speaking" status are looked at again
const SETTLE_MS = 200;

/**
 * Gemini's own voice activity detection, tuned for a conversation: slow to decide the user started (so a cough,
 * a click or a trace of the copilot's echo does not count), quick to decide they finished (a short pause ends
 * the turn, so the answer comes sooner), and the user starting to speak cuts the copilot off.
 */
export const REALTIME_INPUT_CONFIG = {
  automaticActivityDetection: {
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    prefixPaddingMs: 200,
    silenceDurationMs: 600,
  },
  activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
} as const;

export interface VoiceTool {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface VoiceOptions extends LiveOptions {
  instructions: string;
  tools: VoiceTool[];
  // Audio from just before the session, when "Hey Ava" started it: sent first, so the request said
  // in the same breath is heard
  preroll?: Float32Array[];
  // The chosen microphone/speaker (Settings › Voice devices), or null for the system default
  micDeviceId?: string | null;
  speakerDeviceId?: string | null;
  // The fixed voice (and, for models that take it, language) of the conversation, built by the background
  speechConfig?: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } }; languageCode?: string };
}

export interface VoiceEvents {
  // A finished turn: what the user said, what the copilot said
  onTurn: (heard: string, said: string) => void;
  // Runs a tool in the background and returns its result
  // `heard` is what the user has said so far in this turn, so a tool can tell where its arguments came from
  onTool: (name: string, args: Record<string, unknown>, heard: string) => Promise<unknown>;
  onStatus: (status: VoiceStatus, error?: string) => void;
  // Seconds of audio sent and played, for usage
  onUsage: (inputSeconds: number, outputSeconds: number) => void;
}

export function voiceSetup(options: VoiceOptions, resumeHandle: string | null) {
  return {
    setup: {
      model: `models/${options.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        // Without it Gemini picks a voice per session, and the voice (and language) drift between conversations
        ...(options.speechConfig ? { speechConfig: options.speechConfig } : {}),
      },
      systemInstruction: { parts: [{ text: options.instructions }] },
      realtimeInputConfig: REALTIME_INPUT_CONFIG,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [{ functionDeclarations: options.tools }],
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

/** A picture for the model: base64 data and its type. */
export interface TurnImage {
  mediaType: string;
  data: string;
}

/**
 * A message the user typed into the conversation's chat, as one user turn of the Live session: the note about
 * any attached pictures, the pictures as inline data, then the words.
 */
export function typedTurn(text: string, images: TurnImage[] = [], note = '') {
  const parts = [
    ...(images.length && note ? [{ text: note }] : []),
    ...images.map(image => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
    { text: images.length ? `The user typed (with the pictures above): ${text}` : `The user typed: ${text}` },
  ];
  return { clientContent: { turns: [{ role: 'user', parts }], turnComplete: true } };
}

/** Context the model should know but not answer: a user turn left open (turnComplete false). */
export function contextTurn(text: string) {
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false } };
}

/** A screenshot as a Live video frame: realtime input, so it is context for the turn under way, not a new turn. */
export function screenFrame(image: TurnImage) {
  return { realtimeInput: { video: { mimeType: image.mediaType, data: image.data } } };
}

/**
 * Turns the model's 16-bit little-endian PCM into float samples for playback.
 */
export function pcm16ToFloat(base64: string): Float32Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

export class VoiceSession {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private readonly gate = new SpeechGate({ sampleRate: INPUT_RATE });
  private handle: string | null = null;
  private mic: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private micDeviceId: string | null = null;
  private input: AudioContext | null = null;
  private output: AudioContext | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private playAt = 0;
  private heard = '';
  private said = '';
  // Things to say, held until the floor is free (see TurnTaking)
  private notices: string[] = [];
  // The latest quiet context (the tab in front), held the same way
  private context: string | null = null;
  private readonly turns = new TurnTaking();
  // Dictation in the chat box has the microphone: nothing heard goes to the conversation meanwhile
  private micHeld = false;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  // Messages typed in the chat, held until the session is ready
  private typed: ReturnType<typeof typedTurn>[] = [];
  private speaking = false;
  private inputSeconds = 0;
  private outputSeconds = 0;
  private usageTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: VoiceOptions,
    private readonly events: VoiceEvents,
  ) {}

  async start(): Promise<void> {
    this.micDeviceId = this.options.micDeviceId ?? null;
    this.mic = await requestMicStream(navigator.mediaDevices, this.micDeviceId, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    // Ended while the microphone opened: it closes again, and nothing connects
    if (this.stopped) {
      this.mic.getTracks().forEach(track => track.stop());
      return;
    }
    this.output = new AudioContext({ sampleRate: OUTPUT_RATE });
    void setAudioSinkId(this.output, this.options.speakerDeviceId ?? null);
    this.input = new AudioContext({ sampleRate: INPUT_RATE });
    await this.input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const node = new AudioWorkletNode(this.input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = event => this.fromMic(event.data as Float32Array);
    this.node = node;
    this.micSource = this.input.createMediaStreamSource(this.mic);
    this.micSource.connect(node);
    const mute = this.input.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.input.destination);
    this.usageTimer = setInterval(() => this.reportUsage(), 60_000);
    this.settleTimer = setInterval(() => this.settle(), SETTLE_MS);
    this.connect();
  }

  /** Switches microphones mid-conversation without ending it: see WakeListener.switchMic. */
  async switchMic(deviceId: string | null): Promise<void> {
    if (deviceId === this.micDeviceId) return;
    this.micDeviceId = deviceId;
    if (!this.input || !this.node) return;
    const next = await requestMicStream(navigator.mediaDevices, deviceId, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    this.micSource?.disconnect();
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = next;
    this.micSource = this.input.createMediaStreamSource(next);
    this.micSource.connect(this.node);
  }

  /** Switches the speaker this conversation plays through, without ending it. */
  switchSpeaker(deviceId: string | null): void {
    if (this.output) void setAudioSinkId(this.output, deviceId);
  }

  stop(): void {
    this.stopped = true;
    this.reportUsage();
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    this.socket?.close(1000);
    this.mic?.getTracks().forEach(track => track.stop());
    void this.input?.close().catch(() => {});
    void this.output?.close().catch(() => {});
    this.events.onStatus('off');
  }

  /**
   * Holds the microphone (dictation in the chat box has it) or gives it back. While held, nothing heard goes up:
   * an utterance under way ends there, and typed turns still work.
   */
  holdMic(on: boolean): void {
    if (this.micHeld === on) return;
    this.micHeld = on;
    if (!on) return;
    const wasOpen = this.gate.speaking;
    this.gate.reset();
    if (wasOpen) {
      this.turns.userEnded(performance.now());
      if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    }
  }

  /** Something for the copilot to tell the user, said once the floor is free. */
  say(notice: string): void {
    this.notices.push(notice);
    this.flushNotices();
  }

  /** A message the user typed, with any pictures: their turn now, cutting off what the copilot was saying. */
  sendText(text: string, images: TurnImage[] = [], note = ''): void {
    if (!text.trim() && images.length === 0) return;
    this.typed.push(typedTurn(text, images, note));
    this.flushTyped();
  }

  /**
   * Quiet context (the tab the user switched to): added to the conversation without asking for an answer
   * (turnComplete false). Held while the copilot speaks, since client content cuts off what it is saying.
   */
  addContext(text: string): void {
    if (!text.trim()) return;
    // Only the latest matters: an older tab line is out of date
    this.context = text;
    this.flushContext();
  }

  /**
   * A picture of the screen for the model to look at (read_screen), sent as a video frame so it does not start a
   * turn of its own: the tool's answer that follows says what it is. False when the session is not ready.
   */
  sendImage(image: TurnImage): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(screenFrame(image)));
    return true;
  }

  private flushTyped(): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN || this.typed.length === 0) return;
    if (this.speaking) this.silence();
    for (const turn of this.typed.splice(0)) this.socket.send(JSON.stringify(turn));
  }

  /**
   * Microphone audio goes up only while someone speaks: the model bills every second it is sent, so
   * silence stays here. When speech stops, the model is told the stream paused, so it answers at once.
   */
  private fromMic(samples: Float32Array): void {
    if (!this.ready || this.stopped || this.micHeld) return;
    const now = performance.now();
    const wasOpen = this.gate.speaking;
    // While the copilot's voice plays the gate asks for more, so its own echo is not taken for the user
    const { send, ended } = this.gate.push(samples, { playing: this.turns.playing(now) });
    if (!wasOpen && this.gate.speaking) this.turns.userStarted();
    for (const chunk of send) this.send(chunk);
    if (ended) {
      this.turns.userEnded(now);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    }
  }

  /** The copilot stops counting as speaking once its voice has played out; held notices go when the floor is free. */
  private settle(): void {
    if (this.stopped || !this.ready) return;
    const now = performance.now();
    if (this.speaking && !this.turns.speaking(now)) {
      this.speaking = false;
      this.status('listening');
    }
    this.flushContext();
    this.flushNotices();
  }

  /** Whether held client content may go now: see TurnTaking. */
  private floorFree(): boolean {
    return !this.speaking && this.turns.floorFree(performance.now());
  }

  /** Reports how the conversation is going, but never after it ended: a late message must not reopen it. */
  private status(status: VoiceStatus, error?: string): void {
    if (this.stopped && status !== 'off') return;
    this.events.onStatus(status, error);
  }

  private send(samples: Float32Array): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        realtimeInput: { audio: { mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: pcm16Base64(samples) } },
      }),
    );
    this.inputSeconds += samples.length / INPUT_RATE;
  }

  private flushContext(): void {
    if (!this.ready || !this.context || this.socket?.readyState !== WebSocket.OPEN || !this.floorFree()) return;
    const text = this.context;
    this.context = null;
    this.socket.send(JSON.stringify(contextTurn(text)));
  }

  private flushNotices(): void {
    if (!this.ready || this.notices.length === 0 || this.socket?.readyState !== WebSocket.OPEN || !this.floorFree()) {
      return;
    }
    const text = this.notices.splice(0).join('\n');
    this.socket?.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: `System notice. Tell the user, in one short sentence: ${text}` }] }],
          turnComplete: true,
        },
      }),
    );
  }

  private play(base64: string): void {
    if (!this.output) return;
    const samples = pcm16ToFloat(base64);
    const buffer = this.output.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.output.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output.destination);
    // Pieces play back to back, in order
    this.playAt = Math.max(this.playAt, this.output.currentTime);
    source.start(this.playAt);
    this.playAt += buffer.duration;
    // Heard until the queue runs out, plus the device's own delay and the room's
    const latency = (this.output.outputLatency || 0) + (this.output.baseLatency || 0);
    this.turns.playUntil(performance.now() + (this.playAt - this.output.currentTime + latency) * 1000 + ECHO_TAIL_MS);
    this.outputSeconds += buffer.duration;
    this.playing.push(source);
    source.onended = () => {
      this.playing = this.playing.filter(s => s !== source);
    };
  }

  /** The user spoke over the copilot: stop talking at once. */
  private silence(): void {
    for (const source of this.playing) source.stop();
    this.playing = [];
    this.playAt = 0;
    this.turns.stopPlayback(performance.now());
  }

  private reportUsage(): void {
    if (this.inputSeconds > 0 || this.outputSeconds > 0) {
      this.events.onUsage(this.inputSeconds, this.outputSeconds);
      this.inputSeconds = 0;
      this.outputSeconds = 0;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.ready = false;
    this.status('connecting');
    liveSocketUrl(this.options).then(
      url => {
        if (!this.stopped) this.open(url);
      },
      error => this.status('off', error instanceof Error ? error.message : String(error)),
    );
  }

  private open(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify(voiceSetup(this.options, this.handle)));
    socket.onmessage = async event => {
      // Nothing from a socket that was replaced or a session that ended
      if (this.socket !== socket || this.stopped) return;
      const raw = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
      let message: {
        setupComplete?: unknown;
        serverContent?: {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: { parts?: { inlineData?: { data: string } }[] };
          interrupted?: boolean;
          turnComplete?: boolean;
        };
        toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
        sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
        goAway?: unknown;
      };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.setupComplete) {
        this.ready = true;
        this.status('listening');
        // A new (or resumed) session: a turn cut off by the old socket is over
        this.turns.modelEnded();
        // What followed "Hey Ava" is speech already: it goes up, and the gate stays open for the rest
        const preroll = this.options.preroll?.splice(0) ?? [];
        for (const chunk of preroll) this.send(chunk);
        if (preroll.length) {
          this.gate.force();
          this.turns.userStarted();
        }
        this.flushTyped();
        this.flushContext();
        this.flushNotices();
      }
      const content = message.serverContent;
      if (content?.inputTranscription?.text) this.heard += content.inputTranscription.text;
      if (content?.outputTranscription?.text) this.said += content.outputTranscription.text;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.turns.modelStarted();
          if (!this.speaking) {
            this.speaking = true;
            this.status('speaking');
          }
          this.play(part.inlineData.data);
        }
      }
      if (content?.interrupted) {
        this.silence();
        this.turns.interrupted(performance.now());
      }
      if (content?.turnComplete) {
        if (this.heard.trim() || this.said.trim()) this.events.onTurn(this.heard.trim(), this.said.trim());
        this.heard = '';
        this.said = '';
        this.turns.modelEnded();
        // Still "speaking" until the voice already queued has played out: settle() says "listening" then
        this.settle();
      }
      for (const call of message.toolCall?.functionCalls ?? []) {
        let response: unknown;
        this.turns.toolStarted();
        try {
          response = { result: await this.events.onTool(call.name, call.args ?? {}, this.heard) };
        } catch (error) {
          response = { error: String(error) };
        } finally {
          this.turns.toolEnded();
        }
        socket.send(
          JSON.stringify({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] } }),
        );
      }
      if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
        this.handle = message.sessionResumptionUpdate.newHandle;
      }
      if (message.goAway) socket.close(1000);
    };
    socket.onclose = event => {
      if (this.socket !== socket || this.stopped) return;
      this.ready = false;
      // A refused key or model ends the session; anything else reconnects
      if (event.code === 1008 || event.code === 1007) {
        this.status('off', event.reason || 'The voice service refused the session');
        return;
      }
      setTimeout(() => this.connect(), 1000);
    };
  }
}
