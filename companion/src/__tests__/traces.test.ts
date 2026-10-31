import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log';
import { TraceStore } from '../traces/store';
import { tempDir } from './helpers';

const DAY = 24 * 60 * 60_000;
const trace = { resourceSpans: [{ scopeSpans: [] }] };
let dir: ReturnType<typeof tempDir>;
afterEach(() => dir?.remove());

function store(now: number, enabled = true) {
  dir = tempDir();
  return new TraceStore({ dataDir: dir.path, log: createLogger({}, { write: () => {} }), now: () => now, enabled });
}

describe('TraceStore', () => {
  it("adds one line per trace to the day's file, readable by this user only", async () => {
    const traces = store(Date.parse('2026-10-26T20:00:00Z'));
    expect(await traces.keep(trace)).toBe(true);
    await traces.keep(trace);
    const file = join(traces.dir, '2026-10-26.otlp.jsonl');
    expect(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).toEqual([trace, trace]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(traces.dir).mode & 0o777).toBe(0o700);
  });

  it('drops days older than the ones kept, and nothing else in the folder', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z');
    const traces = store(now);
    await traces.keep(trace);
    const old = new Date(now - 20 * DAY).toISOString().slice(0, 10);
    writeFileSync(join(traces.dir, `${old}.otlp.jsonl`), '{}\n');
    writeFileSync(join(traces.dir, 'notes.txt'), 'mine');
    await traces.prune();
    expect(readdirSync(traces.dir).sort()).toEqual(['2026-10-26.otlp.jsonl', 'notes.txt']);
  });

  it('keeps nothing when traces are off', async () => {
    const traces = store(Date.now(), false);
    expect(await traces.keep(trace)).toBe(false);
    expect(() => readdirSync(traces.dir)).toThrow();
  });
});
