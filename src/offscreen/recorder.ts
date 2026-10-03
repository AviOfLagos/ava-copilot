import { meetingStore } from '@extension/storage';
import { ChunkCutter, encodeWav, rms, toBase64 } from './pcm';
import type { ChunkPlan, PcmChunk } from './pcm';
import { LiveCaptions } from './live';
import type { LiveOptions } from './live';

export const SAMPLE_RATE = 16_000;
// Below this loudness a moment counts as silence
const SILENCE_LEVEL = 0.003;
const SILENCE_CHECK_MS = 5_000;

export interface RecorderOptions {
  meetingId: string;
  streamId: string;
  withMic: boolean;
  plan: Omit<ChunkPlan, 'sampleRate'>;
  silenceWarnSeconds: number;
  // Live captions, when the user has them on and a Gemini key
  live?: LiveOptions;
}

type Notify = (message: Record<string, unknown>) => void;

/**
 * Records one meeting: the tab's audio, plus the microphone when asked, mixed to 16 kHz mono and cut
 * into overlapping chunks that go straight into the database. The tab stays audible: capturing a
 * tab mutes it, so its audio is played back to the speakers.
 */
export class Recorder {
  private streams: MediaStream[] = [];
  private playback: AudioContext | null = null;
  private capture: AudioContext | null = null;
  private cutter: ChunkCutter;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastSoundAt = Date.now();
  private warnedSilence = false;
  // Chunks are written one after another, so their order in the database is their order in time
  private writing: Promise<void> = Promise.resolve();
  private live: LiveCaptions | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private reportedSeconds = 0;
  micUsed = false;

  constructor(
    readonly options: RecorderOptions,
    private readonly notify: Notify,
  ) {
    this.cutter = new ChunkCutter({ ...options.plan, sampleRate: SAMPLE_RATE });
  }

  async start(): Promise<void> {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.options.streamId },
      } as MediaTrackConstraints,
    });
    this.streams.push(tab);
    tab
      .getAudioTracks()[0]
      ?.addEventListener('ended', () =>
        this.notify({ type: 'meeting_source_ended', meetingId: this.options.meetingId }),
      );

    // The user keeps hearing the meeting at full quality
    this.playback = new AudioContext();
    this.playback.createMediaStreamSource(tab).connect(this.playback.destination);

    this.capture = new AudioContext({ sampleRate: SAMPLE_RATE });
    const mix = this.capture.createGain();
    this.capture.createMediaStreamSource(tab).connect(mix);

    if (this.options.withMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        this.streams.push(mic);
        this.capture.createMediaStreamSource(mic).connect(mix);
        this.micUsed = true;
      } catch {
        // No permission or no microphone: the meeting is still recorded, without the user's voice
        this.micUsed = false;
      }
    }

    await this.capture.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const node = new AudioWorkletNode(this.capture, 'pcm-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = event => this.onSamples(event.data as Float32Array);
    mix.connect(node);
    // A silent output keeps the graph pulling samples through the worklet
    const mute = this.capture.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.capture.destination);

    this.silenceTimer = setInterval(() => this.checkSilence(), SILENCE_CHECK_MS);

    if (this.options.live) {
      const { meetingId } = this.options;
      const startedAt = Date.now();
      this.live = new LiveCaptions(
        this.options.live,
        text => {
          void meetingStore.addLiveCaption(meetingId, { t: (Date.now() - startedAt) / 1000, text });
        },
        status => {
          void meetingStore.update(meetingId, { live: status });
        },
      );
      this.live.start();
      // Streamed minutes are reported for the cost record and the daily cap
      this.usageTimer = setInterval(() => this.reportUsage(), 60_000);
    }
  }

  /** Stops live captions, e.g. when the daily cost cap is reached; recording goes on. */
  stopLive(): void {
    this.reportUsage();
    this.live?.stop();
    this.live = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
  }

  private reportUsage(): void {
    if (!this.live) return;
    const seconds = this.live.sentSeconds - this.reportedSeconds;
    this.reportedSeconds = this.live.sentSeconds;
    if (seconds > 0) {
      this.notify({ type: 'meeting_live_usage', meetingId: this.options.meetingId, seconds });
    }
  }

  /**
   * Stops recording and writes the last chunk.
   */
  async stop(): Promise<void> {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
    }
    this.stopLive();
    for (const stream of this.streams) {
      stream.getTracks().forEach(track => track.stop());
    }
    await this.capture?.close().catch(() => {});
    await this.playback?.close().catch(() => {});
    const last = this.cutter.flush();
    if (last) {
      this.write(last, true);
    }
    await this.writing;
  }

  private onSamples(samples: Float32Array): void {
    if (rms(samples) > SILENCE_LEVEL) {
      this.lastSoundAt = Date.now();
    }
    this.live?.push(samples, SAMPLE_RATE);
    for (const chunk of this.cutter.push(samples)) {
      this.write(chunk);
    }
  }

  private write(chunk: PcmChunk, final = false): void {
    const { meetingId } = this.options;
    this.writing = this.writing.then(async () => {
      try {
        await meetingStore.addChunk({
          id: crypto.randomUUID(),
          meetingId,
          index: chunk.index,
          tStart: chunk.tStart,
          tEnd: chunk.tEnd,
          mimeType: 'audio/wav',
          data: toBase64(encodeWav(chunk.samples, SAMPLE_RATE)),
          final,
        });
        this.notify({ type: 'meeting_chunk', meetingId, index: chunk.index });
      } catch (error) {
        this.notify({ type: 'meeting_recorder_error', meetingId, error: String(error) });
      }
    });
  }

  private checkSilence(): void {
    const silent = Date.now() - this.lastSoundAt >= this.options.silenceWarnSeconds * 1000;
    if (silent !== this.warnedSilence) {
      this.warnedSilence = silent;
      this.notify({ type: 'meeting_silence', meetingId: this.options.meetingId, silent });
    }
  }
}
