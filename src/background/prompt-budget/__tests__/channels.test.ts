import 'fake-indexeddb/auto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Registrations touch chrome APIs when they load: a stand-in that accepts any call
vi.hoisted(() => {
  const open = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (key === 'then' ? undefined : open()),
      apply: () => open(),
    });
  vi.stubGlobal('chrome', open());
});

const { measureChannels } = await import('../channels');
await import('../../registers');
const { formatTable, growth, toBaseline, sizeChannel, estimateTokens } = await import('../measure');

const BASELINE_FILE = resolve(__dirname, '../baseline.json');

describe('the size of what each channel sends', () => {
  it('prints every part, and fails when a channel or a part grew by more than 10% against the baseline', () => {
    const now = measureChannels();
    // eslint-disable-next-line no-console
    console.log(`\n${formatTable(now)}\n`);
    // UPDATE_PROMPT_BUDGET=1 rewrites the baseline after a change that was meant to move it
    if (process.env.UPDATE_PROMPT_BUDGET) {
      writeFileSync(BASELINE_FILE, `${JSON.stringify(toBaseline(now), null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    expect(growth(baseline, now)).toEqual([]);
  });

  it('counts the channels the research names', () => {
    const now = measureChannels();
    expect(Object.keys(now)).toEqual([
      'panel navigator',
      'panel navigator, in a workspace',
      'whatsapp navigator',
      'agent and routine chats',
      'panel planner',
      'voice',
    ]);
    for (const channel of Object.values(now)) expect(channel.chars).toBeGreaterThan(0);
    // The navigator is where the tools are
    const tools = now['panel navigator']!.parts.find(part => part.name === 'tool definitions')!;
    expect(tools.chars).toBeGreaterThan(20_000);
  });
});

describe('growth', () => {
  const sized = (chars: number) => ({ a: sizeChannel([{ name: 'p', text: 'x'.repeat(chars) }]) });

  it('allows up to 10% and names what went over', () => {
    const baseline = toBaseline(sized(1000));
    expect(growth(baseline, sized(1100))).toEqual([]);
    expect(growth(baseline, sized(1101))).toEqual([
      'a: 1000 → 1101 characters in all',
      'a / p: 1000 → 1101 characters',
    ]);
    expect(growth(baseline, sized(10))).toEqual([]);
  });

  it('measures a new channel or part without failing it', () => {
    expect(growth({}, sized(5000))).toEqual([]);
    expect(estimateTokens(10)).toBe(3);
  });
});
