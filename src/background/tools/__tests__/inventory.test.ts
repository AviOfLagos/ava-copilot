import 'fake-indexeddb/auto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Inventory from '../inventory';
import type * as Registry from '../../registry';
import { enT } from '@src/background/skills/__tests__/en';

vi.mock('@extension/i18n', () => ({ t: enT }));

// Chrome is a stub that answers every call with nothing: the registrations only need it to load
const chromeStub: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : chromeStub),
  apply: () => Promise.resolve(undefined),
});

const DOC = path.resolve(import.meta.dirname, '../../../../docs/tools.md');

let inventory: typeof Inventory;
let registry: typeof Registry;

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub);
  await import('@src/background/registers');
  inventory = await import('../inventory');
  registry = await import('../../registry');
}, 120_000);

describe('the tool inventory', () => {
  it('builds every chat action: one that throws fails here instead of being left out of the list', () => {
    const { failures } = registry.buildRegisteredActionsStrict({} as never);
    expect(failures).toEqual([]);
    expect(() => inventory.builtChatActions()).not.toThrow();
  });

  it('has a row for every chat action and every voice tool', async () => {
    const { VOICE_TOOLS } = await import('@src/background/voice/prompt');
    const rows = new Map(inventory.toolInventory().map(row => [row.name, row]));
    const chat = inventory.builtChatActions().map(action => action.name());
    const voice = [
      ...VOICE_TOOLS.map(tool => tool.name),
      ...registry.registeredVoiceTools().map(t => t.declaration.name),
    ];
    expect(chat.length).toBeGreaterThan(50);
    expect(voice.length).toBeGreaterThan(50);
    expect(chat.filter(name => !rows.has(name))).toEqual([]);
    expect(voice.filter(name => !rows.has(name))).toEqual([]);
    for (const name of chat) expect(rows.get(name)!.channels.length, name).toBeGreaterThan(0);
  });

  it('gives every tool a group in TOOL_GROUPS (a tool under "More" has none)', () => {
    const ungrouped = inventory
      .toolInventory()
      .filter(row => !row.group)
      .map(row => row.name);
    expect(ungrouped).toEqual([]);
  });

  it('keeps docs/tools.md equal to what is registered', () => {
    const table = inventory.renderToolTable(inventory.toolInventory());
    if (process.env.UPDATE_TOOLS_TABLE === '1') writeFileSync(DOC, table);
    expect(existsSync(DOC), 'docs/tools.md is missing: run with UPDATE_TOOLS_TABLE=1').toBe(true);
    expect(readFileSync(DOC, 'utf8'), 'docs/tools.md is out of date: run with UPDATE_TOOLS_TABLE=1').toBe(table);
  });
});
