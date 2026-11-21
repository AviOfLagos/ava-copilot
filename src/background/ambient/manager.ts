import type {
  AmbientSettingsConfig,
  AmbientStore,
  AmbientSession,
  AmbientUtterance,
  SttChoice,
} from '@extension/storage';
import { matchAmbientSwitch } from './phrases';
import type { AmbientSwitch } from './phrases';

/**
 * Ambient listening in the background (docs/ambient-plan.md, A1). The offscreen document writes down what is said
 * around the Mac with the local recogniser and sends each utterance here as text; this files it in a session,
 * obeys the few spoken switches, forgets on request, and keeps everything only as long as the retention.
 *
 * What Ava hears is untrusted: it never reaches a tool or a model from here. The only thing done with it besides
 * storing it is matching the switches in ./phrases, word for word. It reaches the knowledge base (and so the
 * embedder, the graph and any model that answers from it) only while the user lets the cloud model use it.
 */

export type AmbientIndicator = { mode: AmbientSettingsConfig['mode']; offRecord: boolean; running: boolean };

export interface AmbientDeps {
  settings: {
    getSettings: () => Promise<AmbientSettingsConfig>;
    updateSettings: (changes: Partial<AmbientSettingsConfig>) => Promise<void>;
  };
  store: Pick<
    AmbientStore,
    'add' | 'forgetSince' | 'removeOlderThan' | 'retentionCutoff' | 'utterances' | 'sessions'
  > & {
    session: (id: string) => Promise<AmbientSession | undefined>;
  };
  kb: () => {
    indexAmbient: (session: AmbientSession, utterances: AmbientUtterance[]) => Promise<unknown>;
    forget: (sourceType: 'ambient', sourceId: string) => Promise<void>;
  };
  offscreen: {
    start: (config: { stt: SttChoice; lowPowerStt: SttChoice; offRecord: boolean; nameWords: string[] }) => Promise<{
      ok?: boolean;
      error?: string;
      micDenied?: boolean;
    }>;
    stop: () => Promise<void>;
  };
  // The local recogniser to listen with, or null when none is installed
  stt: () => Promise<{ stt: SttChoice; lowPowerStt: SttChoice } | null>;
  // The assistant's name, as the words the switches start with
  nameWords: () => Promise<string[]>;
  indicate: (state: AmbientIndicator) => void;
  // The user's vocabulary applied to what was heard (docs/pm-desk.md, Part 4); left out, the words are kept as written
  correct?: (text: string) => Promise<string>;
  now?: () => number;
  // How long after the last utterance a session is (re)indexed, so a long talk is not indexed line by line
  indexDelayMs?: number;
}

export type SyncResult = { ok: boolean; error?: string; micDenied?: boolean };

export class AmbientManager {
  private readonly now: () => number;
  private readonly indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(private readonly deps: AmbientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Starts, reconfigures or stops listening to match the settings. */
  async sync(): Promise<SyncResult> {
    const settings = await this.deps.settings.getSettings();
    if (settings.mode === 'off') {
      if (this.running) await this.deps.offscreen.stop().catch(() => {});
      this.running = false;
      this.indicate(settings);
      return { ok: true };
    }
    const stt = await this.deps.stt();
    if (!stt) {
      this.running = false;
      this.indicate(settings);
      return { ok: false, error: 'missing_stt' };
    }
    const result = await this.deps.offscreen
      .start({ ...stt, offRecord: settings.offRecord, nameWords: await this.deps.nameWords() })
      .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error), micDenied: false }));
    this.running = !!result?.ok;
    this.indicate(settings);
    return { ok: this.running, error: result?.error, micDenied: result?.micDenied };
  }

  /** One utterance from the offscreen document: a switch to obey, or words to keep. */
  async heard(utterance: { text: string; startedAt: number; endedAt: number }): Promise<void> {
    const settings = await this.deps.settings.getSettings();
    if (settings.mode === 'off' || settings.offRecord) return;
    const text = utterance.text.trim().slice(0, 4000);
    if (!text) return;
    const command = matchAmbientSwitch(text, await this.deps.nameWords());
    // A switch is said to Ava, not part of the talk: it is obeyed and never kept
    if (command) {
      await this.apply(command);
      return;
    }
    const now = this.now();
    const endedAt = Math.min(utterance.endedAt, now);
    const startedAt = Math.min(utterance.startedAt, endedAt);
    // After the switches: a spoken switch is matched on what was heard, and only the words kept are corrected
    const kept = this.deps.correct ? await this.deps.correct(text).catch(() => text) : text;
    const { session } = await this.deps.store.add({ text: kept, startedAt, endedAt });
    if (settings.cloudAllowed) this.scheduleIndex(session.id);
  }

  /** "Back on the record", heard while off it (the offscreen document listens only for that). */
  async backOnRecord(): Promise<void> {
    await this.apply({ kind: 'on_record' });
  }

  async apply(command: AmbientSwitch): Promise<void> {
    switch (command.kind) {
      case 'listen':
        return this.deps.settings.updateSettings({ mode: 'listen' });
      case 'companion':
        return this.deps.settings.updateSettings({ mode: 'companion' });
      case 'quiet':
        return this.deps.settings.updateSettings({ mode: 'off', offRecord: false, offRecordSince: null });
      case 'off_record':
        return this.deps.settings.updateSettings({ offRecord: true, offRecordSince: this.now() });
      case 'on_record':
        return this.deps.settings.updateSettings({ offRecord: false, offRecordSince: null });
      case 'forget':
        await this.forget(command.minutes);
        return;
    }
  }

  /** Deletes the last `minutes` of what was heard, here and in the knowledge base. */
  async forget(minutes: number): Promise<{ removed: number; changed: number }> {
    const since = this.now() - minutes * 60_000;
    const result = await this.deps.store.forgetSince(since);
    await this.afterDeletion(result);
    return { removed: result.removed.length, changed: result.changed.length };
  }

  /** Drops what is older than the retention. */
  async applyRetention(): Promise<number> {
    const result = await this.deps.store.removeOlderThan(this.deps.store.retentionCutoff(this.now()));
    await this.afterDeletion(result);
    return result.removed.length + result.changed.length;
  }

  /**
   * The user turned the cloud permission on or off: the sessions kept so far join the knowledge base, or leave it.
   */
  async cloudChanged(allowed: boolean): Promise<void> {
    const sessions = await this.deps.store.sessions(500);
    for (const session of sessions) {
      if (allowed) await this.index(session.id);
      else await this.deps.kb().forget('ambient', session.id);
    }
    if (!allowed) this.clearTimers();
  }

  /** The indicator, for a page that just opened. */
  async state(): Promise<AmbientIndicator> {
    const settings = await this.deps.settings.getSettings();
    return { mode: settings.mode, offRecord: settings.offRecord, running: this.running };
  }

  private async afterDeletion({ changed, removed }: { changed: string[]; removed: string[] }): Promise<void> {
    const { cloudAllowed } = await this.deps.settings.getSettings();
    for (const id of removed) {
      this.clearTimer(id);
      await this.deps.kb().forget('ambient', id);
    }
    for (const id of changed) {
      if (cloudAllowed) await this.index(id);
      else await this.deps.kb().forget('ambient', id);
    }
  }

  private scheduleIndex(sessionId: string): void {
    this.clearTimer(sessionId);
    this.indexTimers.set(
      sessionId,
      setTimeout(() => {
        this.indexTimers.delete(sessionId);
        void this.index(sessionId).catch(() => {});
      }, this.deps.indexDelayMs ?? 30_000),
    );
  }

  private async index(sessionId: string): Promise<void> {
    const { cloudAllowed } = await this.deps.settings.getSettings();
    if (!cloudAllowed) return;
    const session = await this.deps.store.session(sessionId);
    if (!session) {
      await this.deps.kb().forget('ambient', sessionId);
      return;
    }
    await this.deps.kb().indexAmbient(session, await this.deps.store.utterances(sessionId));
  }

  private clearTimer(sessionId: string): void {
    const timer = this.indexTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.indexTimers.delete(sessionId);
  }

  private clearTimers(): void {
    for (const timer of this.indexTimers.values()) clearTimeout(timer);
    this.indexTimers.clear();
  }

  private indicate(settings: AmbientSettingsConfig): void {
    this.deps.indicate({ mode: settings.mode, offRecord: settings.offRecord, running: this.running });
  }
}
