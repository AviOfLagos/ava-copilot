import { matchAmbientSwitch } from '../../background/ambient/phrases';
import { isRequest, UtteranceCollector } from '../stt/utterances';

/**
 * Ambient listening's ears (docs/ambient-plan.md, A1): microphone audio in, one written-down utterance out per
 * stretch of speech, by the local recogniser only. Nothing here sends audio anywhere, and no audio is kept once
 * it is transcribed. Off the record, an utterance is written down only to hear "back on the record": its words go
 * nowhere and are dropped at once.
 */

export type ScribeEvent =
  | { type: 'ambient_utterance'; text: string; startedAt: number; endedAt: number }
  | { type: 'ambient_back_on_record' }
  | { type: 'ambient_error'; error: string };

// Why listening is paused: a voice conversation, dictation in the chat box, or a meeting being recorded
export type PauseReason = 'voice' | 'dictation' | 'recorder';

export interface ScribeOptions {
  transcribe: (audio: Float32Array) => Promise<string>;
  emit: (event: ScribeEvent) => void;
  now?: () => number;
  sampleRate?: number;
}

export class AmbientScribe {
  private readonly collector: UtteranceCollector;
  private readonly now: () => number;
  private readonly pauses = new Set<PauseReason>();
  private queue: Promise<void> = Promise.resolve();
  private speechAt: number | null = null;
  private offRecord = false;
  private nameWords: string[] = ['ava'];

  constructor(private readonly options: ScribeOptions) {
    this.now = options.now ?? Date.now;
    // A longer pause than a conversation's ends an utterance: people trail off mid-thought around a table
    this.collector = new UtteranceCollector({
      sampleRate: options.sampleRate ?? 16_000,
      hangoverMs: 900,
      maxMs: 25_000,
    });
  }

  configure({ offRecord, nameWords }: { offRecord?: boolean; nameWords?: string[] }): void {
    if (offRecord !== undefined) this.offRecord = offRecord;
    if (nameWords?.length) this.nameWords = nameWords;
  }

  get paused(): boolean {
    return this.pauses.size > 0;
  }

  get isOffRecord(): boolean {
    return this.offRecord;
  }

  /** Stops hearing for one reason; listening goes on only when every reason is gone. */
  pause(reason: PauseReason): void {
    this.pauses.add(reason);
    this.collector.cancel();
    this.speechAt = null;
  }

  resume(reason: PauseReason): void {
    this.pauses.delete(reason);
  }

  push(samples: Float32Array, playing = false): void {
    if (this.paused) return;
    const step = this.collector.push(samples, { playing });
    if (step.speechStarted) this.speechAt = this.now();
    if (!step.utterance) return;
    const endedAt = this.now();
    const startedAt =
      this.speechAt ?? endedAt - Math.round((step.utterance.length / (this.options.sampleRate ?? 16_000)) * 1000);
    this.speechAt = this.collector.speaking ? endedAt : null;
    const audio = step.utterance;
    this.queue = this.queue.then(() => this.handle(audio, startedAt, endedAt));
  }

  /** Resolves once every utterance heard so far is written down (tests, and stopping cleanly). */
  settled(): Promise<void> {
    return this.queue;
  }

  private async handle(audio: Float32Array, startedAt: number, endedAt: number): Promise<void> {
    let text: string;
    try {
      text = (await this.options.transcribe(audio)).trim();
    } catch (error) {
      // A recogniser replaced or unloaded mid-utterance (a conversation started): the utterance is lost, listening goes on
      if (!this.paused)
        this.options.emit({ type: 'ambient_error', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (this.paused || !isRequest(text)) return;
    if (this.offRecord) {
      if (matchAmbientSwitch(text, this.nameWords)?.kind === 'on_record')
        this.options.emit({ type: 'ambient_back_on_record' });
      return;
    }
    this.options.emit({ type: 'ambient_utterance', text, startedAt, endedAt });
  }
}
