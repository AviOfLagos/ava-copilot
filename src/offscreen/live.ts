/**
 * Live captions from the Gemini Live API. The recorder streams the same 16 kHz audio it records;
 * the API sends back a transcript of each remark about a second after the speaker pauses.
 * Captions are the quick layer only: the chunked transcript stays the record, so a dropped
 * connection costs captions, never words.
 */

export const LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export interface LiveOptions {
  endpoint: string;
  apiKey: string;
  model: string;
}

export type LiveStatus = 'connecting' | 'on' | 'reconnecting' | 'off';

const MAX_BACKOFF_MS = 30_000;

/**
 * Converts float samples to the API's audio: 16-bit little-endian PCM, base64.
 */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The first message of a session. The Live models only answer with audio, so the answer is capped
 * at one token: that stops the reply, and its cost, while the transcript of the input still comes.
 */
export function liveSetup(model: string, resumeHandle: string | null) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'], maxOutputTokens: 1 },
      systemInstruction: { parts: [{ text: 'You are a silent listener. Never reply.' }] },
      inputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 500 },
      },
      // Sessions end after 15 minutes of audio; a resumption handle carries on in a new one
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

export class LiveCaptions {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private handle: string | null = null;
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Seconds of audio sent, for usage
  sentSeconds = 0;

  constructor(
    private readonly options: LiveOptions,
    private readonly onCaption: (text: string) => void,
    private readonly onStatus: (status: LiveStatus) => void,
  ) {}

  start(): void {
    this.connect();
  }

  /** Streams samples; while the connection is down they are skipped, the recording has them. */
  push(samples: Float32Array, sampleRate: number): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        realtimeInput: { audio: { mimeType: `audio/pcm;rate=${sampleRate}`, data: pcm16Base64(samples) } },
      }),
    );
    this.sentSeconds += samples.length / sampleRate;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.onStatus('off');
  }

  private connect(): void {
    if (this.stopped) return;
    this.ready = false;
    this.onStatus(this.failures === 0 && !this.handle ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(`${this.options.endpoint}?key=${encodeURIComponent(this.options.apiKey)}`);
    this.socket = socket;

    socket.onopen = () => socket.send(JSON.stringify(liveSetup(this.options.model, this.handle)));
    socket.onmessage = async event => {
      const raw = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
      let message: {
        setupComplete?: unknown;
        serverContent?: { inputTranscription?: { text?: string } };
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
        this.failures = 0;
        this.onStatus('on');
      }
      const text = message.serverContent?.inputTranscription?.text?.trim();
      if (text) this.onCaption(text);
      if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
        this.handle = message.sessionResumptionUpdate.newHandle;
      }
      if (message.goAway) {
        // The server is about to end the session: move to a new one now
        socket.close(1000);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.ready = false;
      this.failures += 1;
      const delay = Math.min(1000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
      this.onStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), this.failures === 1 ? 0 : delay);
    };
  }
}
