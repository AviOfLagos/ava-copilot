import { pcm16Base64 } from './live';
import type { LiveOptions } from './live';

/**
 * A spoken conversation with the copilot over the Gemini Live API: the microphone goes up, the
 * model's voice comes back and plays. The model works through tools, which the background runs.
 * It can be told things to say (a task finished, a send waits for Confirm), and it never approves
 * anything: approval stays a click.
 */

export const OUTPUT_RATE = 24_000;
const INPUT_RATE = 16_000;

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
}

export interface VoiceEvents {
  // A finished turn: what the user said, what the copilot said
  onTurn: (heard: string, said: string) => void;
  // Runs a tool in the background and returns its result
  onTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onStatus: (status: 'connecting' | 'listening' | 'speaking' | 'off', error?: string) => void;
  // Seconds of audio sent and played, for usage
  onUsage: (inputSeconds: number, outputSeconds: number) => void;
}

export function voiceSetup(options: VoiceOptions, resumeHandle: string | null) {
  return {
    setup: {
      model: `models/${options.model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: options.instructions }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [{ functionDeclarations: options.tools }],
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
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
  private handle: string | null = null;
  private mic: MediaStream | null = null;
  private input: AudioContext | null = null;
  private output: AudioContext | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private playAt = 0;
  private heard = '';
  private said = '';
  // Things to say, held until the copilot is not speaking
  private notices: string[] = [];
  private speaking = false;
  private inputSeconds = 0;
  private outputSeconds = 0;
  private usageTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: VoiceOptions,
    private readonly events: VoiceEvents,
  ) {}

  async start(): Promise<void> {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.output = new AudioContext({ sampleRate: OUTPUT_RATE });
    this.input = new AudioContext({ sampleRate: INPUT_RATE });
    await this.input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const node = new AudioWorkletNode(this.input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = event => this.send(event.data as Float32Array);
    this.input.createMediaStreamSource(this.mic).connect(node);
    const mute = this.input.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.input.destination);
    this.usageTimer = setInterval(() => this.reportUsage(), 60_000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reportUsage();
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.socket?.close(1000);
    this.mic?.getTracks().forEach(track => track.stop());
    void this.input?.close().catch(() => {});
    void this.output?.close().catch(() => {});
    this.events.onStatus('off');
  }

  /** Something for the copilot to tell the user, said once it is not speaking. */
  say(notice: string): void {
    this.notices.push(notice);
    this.flushNotices();
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

  private flushNotices(): void {
    if (!this.ready || this.speaking || this.notices.length === 0) return;
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
    this.events.onStatus('connecting');
    const socket = new WebSocket(`${this.options.endpoint}?key=${encodeURIComponent(this.options.apiKey)}`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify(voiceSetup(this.options, this.handle)));
    socket.onmessage = async event => {
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
        this.events.onStatus('listening');
        this.flushNotices();
      }
      const content = message.serverContent;
      if (content?.inputTranscription?.text) this.heard += content.inputTranscription.text;
      if (content?.outputTranscription?.text) this.said += content.outputTranscription.text;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          if (!this.speaking) {
            this.speaking = true;
            this.events.onStatus('speaking');
          }
          this.play(part.inlineData.data);
        }
      }
      if (content?.interrupted) this.silence();
      if (content?.turnComplete) {
        if (this.heard.trim() || this.said.trim()) this.events.onTurn(this.heard.trim(), this.said.trim());
        this.heard = '';
        this.said = '';
        this.speaking = false;
        this.events.onStatus('listening');
        this.flushNotices();
      }
      for (const call of message.toolCall?.functionCalls ?? []) {
        let response: unknown;
        try {
          response = { result: await this.events.onTool(call.name, call.args ?? {}) };
        } catch (error) {
          response = { error: String(error) };
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
        this.events.onStatus('off', event.reason || 'The voice service refused the session');
        return;
      }
      setTimeout(() => this.connect(), 1000);
    };
  }
}
