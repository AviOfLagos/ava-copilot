import { appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TRACE_KEEP_DAYS } from '@protocol';
import { privateDir } from '../config';
import type { Logger } from '../log';

/**
 * The extension's traces (one per turn: the user's message, each model call, the answer), kept on this Mac for
 * Suture to read: one OTLP/JSON request per line in `traces/<YYYY-MM-DD>.otlp.jsonl`, files 0600 in a 0700
 * folder, dropped after TRACE_KEEP_DAYS. Nothing here sends them anywhere. `AVA_TRACES=off` keeps none.
 */

const DAY_MS = 24 * 60 * 60_000;
const FILE = /^(\d{4}-\d{2}-\d{2})\.otlp\.jsonl$/;

export class TraceStore {
  readonly dir: string;
  private readonly enabled: boolean;
  private prunedDay = '';

  constructor(
    private readonly deps: { dataDir: string; log: Logger; now: () => number; enabled?: boolean; keepDays?: number },
  ) {
    this.dir = join(deps.dataDir, 'traces');
    this.enabled = deps.enabled ?? true;
  }

  /** Adds one trace to today's file. False when traces are off. */
  async keep(trace: unknown): Promise<boolean> {
    if (!this.enabled) return false;
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    privateDir(this.dir);
    await appendFile(join(this.dir, `${day}.otlp.jsonl`), `${JSON.stringify(trace)}\n`, { mode: 0o600 });
    if (this.prunedDay !== day) {
      this.prunedDay = day;
      await this.prune().catch(error => this.deps.log.warn('Old traces were not removed', { error: String(error) }));
    }
    return true;
  }

  /** Removes the files older than the days kept. */
  async prune(): Promise<void> {
    const keepFrom = new Date(this.deps.now() - (this.deps.keepDays ?? TRACE_KEEP_DAYS) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const day = FILE.exec(name)?.[1];
      if (day && day < keepFrom) await rm(join(this.dir, name), { force: true });
    }
  }
}
