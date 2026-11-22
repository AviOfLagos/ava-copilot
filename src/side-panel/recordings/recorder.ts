import { liveQuery } from 'dexie';
import { db, RECORDING_SILENCE_MS, recordingStore } from '@extension/storage';
import type { RecordingEnd, RecordingSurface } from '@extension/storage';

/**
 * The panel's screen recorder (docs/pm-desk.md, Part 7). It runs here, not in the offscreen document, which is the
 * meeting recorder's and cannot be recreated during a call: meeting notes keep running while it records.
 *
 * - It starts only from a click: `start` refuses unless the page has the user's activation right now, and
 *   `getDisplayMedia` is the first thing it calls, with no message hop before it (Chrome refuses it otherwise).
 * - The picker opens on tabs; a window or the whole screen waits for "Record anyway" (everything visible on it would
 *   be in the recording).
 * - Avi's microphone is mixed in when the browser lets the panel have it; a tab's sound comes with a tab.
 * - Every second's chunk goes to disk-backed storage at once (`recordingChunks`), so a long recording is not held
 *   in memory, and a panel that closes mid-recording leaves everything up to its last second.
 * - It stops on Stop, at the time limit (a setting), after two minutes of silence, when the call that was being
 *   noted ends, or when the shared tab or window goes away.
 */

export type RecorderPhase = 'idle' | 'picking' | 'confirm_surface' | 'recording' | 'stopping';

export interface RecorderState {
  phase: RecorderPhase;
  taskId: string | null;
  taskTitle: string;
  recordingId: string | null;
  // performance.now() at the first frame, for the timer
  startedAt: number | null;
  surface: RecordingSurface | null;
  withMic: boolean;
  maxMs: number;
  // A plain sentence the bar shows (no microphone, the picker refused)
  note: string | null;
  // The recording that just stopped, for the panel to follow as it is saved
  lastId: string | null;
}

const IDLE: RecorderState = {
  phase: 'idle',
  taskId: null,
  taskTitle: '',
  recordingId: null,
  startedAt: null,
  surface: null,
  withMic: false,
  maxMs: 10 * 60_000,
  note: null,
  lastId: null,
};

// What the picker is asked for: tabs first, this panel never offered, the tab's sound kept audible to Avi
export const DISPLAY_OPTIONS = {
  video: { displaySurface: 'browser', frameRate: { ideal: 15, max: 30 } },
  audio: { suppressLocalAudioPlayback: false },
  preferCurrentTab: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'include',
} as DisplayMediaStreamOptions;

const MIME_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/** The best WebM this browser can write. */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  return MIME_TYPES.find(type => isSupported(type)) ?? 'video/webm';
}

// A level (RMS, 0–1) above this counts as someone speaking or something playing
export const SOUND_LEVEL = 0.01;

/** Two minutes with nothing above the sound level ends a recording. */
export class SilenceWatch {
  private lastSound: number;
  constructor(
    start: number,
    private readonly limitMs = RECORDING_SILENCE_MS,
  ) {
    this.lastSound = start;
  }
  /** Feeds a level; true once it has been quiet for the whole limit. */
  hear(level: number, at: number): boolean {
    if (level > SOUND_LEVEL) this.lastSound = at;
    return at - this.lastSound >= this.limitMs;
  }
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

type Request = <T>(message: Record<string, unknown>) => Promise<T>;

export interface RecorderDeps {
  request: Request;
  media: () => MediaDevices;
  // Whether the page has the user's click right now
  activated: () => boolean;
  connect: () => chrome.runtime.Port;
  now: () => number;
}

const defaultRequest: Request = async <T>(message: Record<string, unknown>) => {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: T } | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply.result as T;
};

const defaultDeps: RecorderDeps = {
  request: defaultRequest,
  media: () => navigator.mediaDevices,
  activated: () => navigator.userActivation?.isActive ?? false,
  connect: () => chrome.runtime.connect({ name: 'screen-recording' }),
  now: () => performance.now(),
};

export class ScreenRecorder {
  private state: RecorderState = IDLE;
  private readonly listeners = new Set<(state: RecorderState) => void>();
  private display: MediaStream | null = null;
  private mic: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private port: chrome.runtime.Port | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopCall: (() => void) | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private index = 0;
  private confirm: ((go: boolean) => void) | null = null;

  constructor(private readonly deps: RecorderDeps = defaultDeps) {}

  get current(): RecorderState {
    return this.state;
  }

  subscribe(listener: (state: RecorderState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(changes: Partial<RecorderState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Starts recording for a task. Call it straight from the click handler, before anything else is awaited.
   *
   * @returns false when it did not start: no click behind it, or a recording is already on
   */
  start(task: { id: string; title: string }): boolean {
    if (this.state.phase !== 'idle') return false;
    // Recording never starts by itself (rule 4): only a click in the panel gets this far
    if (!this.deps.activated()) return false;
    let picking: Promise<MediaStream>;
    try {
      // The first call, inside the click: no message hop and no await before it
      picking = this.deps.media().getDisplayMedia(DISPLAY_OPTIONS);
    } catch (error) {
      this.set({ ...IDLE, note: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.set({ ...IDLE, phase: 'picking', taskId: task.id, taskTitle: task.title });
    void this.afterPick(picking, task.id);
    return true;
  }

  /** "Record anyway" after picking a window or the whole screen. */
  confirmSurface(): void {
    this.confirm?.(true);
  }

  /** Puts the picked stream back without recording. */
  cancel(): void {
    if (this.confirm) this.confirm(false);
  }

  private async afterPick(picking: Promise<MediaStream>, taskId: string): Promise<void> {
    try {
      this.display = await picking;
    } catch {
      // Closed the picker, or the browser refused: nothing was recorded
      this.set({ ...IDLE });
      return;
    }
    const video = this.display.getVideoTracks()[0];
    const surface = (video?.getSettings().displaySurface ?? null) as RecordingSurface | null;
    this.set({ surface });
    if (surface && surface !== 'browser') {
      this.set({ phase: 'confirm_surface' });
      const go = await new Promise<boolean>(resolve => (this.confirm = resolve));
      this.confirm = null;
      if (!go) {
        this.release();
        this.set({ ...IDLE });
        return;
      }
    }
    try {
      this.mic = await this.deps.media().getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      this.mic = null;
    }
    try {
      await this.begin(taskId, surface);
    } catch (error) {
      // The browser could not record this stream; anything already written is closed by the background
      this.release();
      this.port?.disconnect();
      this.port = null;
      this.set({ ...IDLE, note: error instanceof Error ? error.message : String(error) });
    }
  }

  private async begin(taskId: string, surface: RecordingSurface | null): Promise<void> {
    const display = this.display!;
    const tabAudio = display.getAudioTracks();
    const withMic = Boolean(this.mic?.getAudioTracks().length);
    const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    let analyser: AnalyserNode | null = null;
    if (tabAudio.length || withMic) {
      this.audio = new AudioContext();
      const mix = this.audio.createMediaStreamDestination();
      analyser = this.audio.createAnalyser();
      analyser.fftSize = 2048;
      for (const stream of [tabAudio.length ? new MediaStream(tabAudio) : null, withMic ? this.mic : null]) {
        if (!stream) continue;
        const source = this.audio.createMediaStreamSource(stream);
        source.connect(mix);
        source.connect(analyser);
      }
      tracks.push(...mix.stream.getAudioTracks());
    }
    const mimeType = pickMimeType(type => MediaRecorder.isTypeSupported(type));
    let begun: { id: string; maxMinutes: number };
    try {
      begun = await this.deps.request({
        type: 'recordings_begin',
        taskId,
        surface,
        withMic,
        withTabAudio: tabAudio.length > 0,
        mimeType,
      });
    } catch (error) {
      this.release();
      this.set({ ...IDLE, note: error instanceof Error ? error.message : String(error) });
      return;
    }
    const id = begun.id;
    this.port = this.deps.connect();
    this.port.postMessage({ type: 'watch', id });
    this.index = 0;
    this.writes = Promise.resolve();
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 2_000_000 });
    this.recorder = recorder;
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const index = this.index++;
      this.writes = this.writes.then(() => recordingStore.addChunk(id, index, event.data)).catch(() => false);
    };
    const startedAt = this.deps.now();
    recorder.start(1000);
    const maxMs = begun.maxMinutes * 60_000;
    this.set({ phase: 'recording', recordingId: id, startedAt, withMic, maxMs, surface, note: null });

    // The shared tab or window went away, or Chrome's own "Stop sharing" was pressed
    display.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop('track_ended'));
    const silence = new SilenceWatch(startedAt);
    const samples = new Float32Array(analyser?.fftSize ?? 0);
    this.timers.push(
      setInterval(() => {
        const at = this.deps.now();
        if (at - startedAt >= maxMs) void this.stop('limit');
        else if (analyser) {
          analyser.getFloatTimeDomainData(samples);
          if (silence.hear(rms(samples), at)) void this.stop('silence');
        }
      }, 500),
      // Keeps the background awake and the port alive while recording
      setInterval(() => this.port?.postMessage({ type: 'beat', id }), 15_000),
    );
    this.watchCall();
  }

  /** A call being noted when the recording started ends it when it ends. */
  private watchCall(): void {
    let meetingId: string | null = null;
    const subscription = liveQuery(() => db.meetings.where('status').equals('recording').toArray()).subscribe({
      next: meetings => {
        if (meetingId === null) {
          meetingId = meetings[0]?.id ?? '';
          return;
        }
        if (meetingId && !meetings.some(meeting => meeting.id === meetingId)) void this.stop('call_ended');
      },
      error: () => undefined,
    });
    this.stopCall = () => subscription.unsubscribe();
  }

  /** Stops, keeps everything captured, and hands it to the background to save. */
  async stop(how: RecordingEnd = 'stop'): Promise<void> {
    if (this.state.phase !== 'recording') return;
    const id = this.state.recordingId!;
    const durationMs = Math.round(this.deps.now() - (this.state.startedAt ?? this.deps.now()));
    this.set({ phase: 'stopping' });
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>(resolve => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    await this.writes;
    this.release();
    try {
      await this.deps.request({ type: 'recordings_finish', id, endedBy: how, durationMs });
      this.port?.postMessage({ type: 'done', id });
    } catch {
      // The port's drop closes it in the background
    }
    this.port?.disconnect();
    this.port = null;
    this.set({ ...IDLE, lastId: id });
  }

  private release(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.stopCall?.();
    this.stopCall = null;
    for (const stream of [this.display, this.mic]) stream?.getTracks().forEach(track => track.stop());
    this.display = null;
    this.mic = null;
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
    this.recorder = null;
  }
}

/** The panel's one recorder: it outlives every page of the panel, so moving around never stops a recording. */
export const screenRecorder = new ScreenRecorder();

/**
 * Downloads a recording from the panel with a blob link: what is left when neither Drive nor Ava Brain can take
 * it. No permission is needed; the browser puts it in the Downloads folder.
 */
export async function downloadRecording(id: string, request: Request = defaultRequest): Promise<boolean> {
  const record = await recordingStore.get(id);
  const blob = record ? await recordingStore.blob(id, record.mimeType) : null;
  if (!record || !blob) return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = record.fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  await request({ type: 'recordings_downloaded', id }).catch(() => undefined);
  return true;
}
