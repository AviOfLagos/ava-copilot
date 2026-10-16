import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCapabilities,
  capabilityNames,
  compactCapabilities,
  findPlace,
  fullCapabilities,
  shortDescription,
  TOOL_GROUPS,
} from '../catalog';
import { VOICE_TOOLS } from '../../voice/prompt';

const places = [
  { id: 'chat', label: 'Home' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'models', label: 'Models & usage' },
  { id: 'settings', label: 'Settings' },
];
const settingsSections = [
  { id: 'voice', label: 'Voice' },
  { id: 'audio-devices', label: 'Audio devices' },
  { id: 'voice-engines', label: 'Voice engines' },
];

describe('buildCapabilities', () => {
  it('lists every tool once, grouped, with unknown ones under More', () => {
    const capabilities = buildCapabilities({
      voiceTools: [
        ...VOICE_TOOLS.map(tool => ({ name: tool.name, description: tool.description })),
        { name: 'check_audio', description: 'Checks the mic. Then more words.' },
        { name: 'brand_new_tool', description: 'Does something new.' },
        // Registered twice by mistake: listed once
        { name: 'read_screen', description: 'A duplicate.' },
      ],
      agentActions: [
        { name: 'click_element', description: 'Click element by index' },
        { name: 'click_element', description: 'dup' },
      ],
      places,
      settingsSections,
    });
    const names = capabilityNames(capabilities);
    for (const tool of VOICE_TOOLS) expect(names).toContain(tool.name);
    expect(names).toContain('check_audio');
    expect(names).toContain('brand_new_tool');
    expect(new Set(names).size).toBe(names.length);
    expect(capabilities.groups.find(group => group.id === 'more')?.entries.map(e => e.name)).toEqual([
      'brand_new_tool',
    ]);
    expect(capabilities.groups.find(group => group.id === 'settings')?.entries[0]).toEqual({
      name: 'check_audio',
      description: 'Checks the mic.',
    });
    expect(capabilities.agentActions).toHaveLength(1);

    const compact = compactCapabilities(capabilities);
    expect(compact).toMatch(/Your screen and tabs: run_browser_task|Your screen and tabs: read_screen/);
    expect(compact).toContain('Places in the side panel (open_place): Home, Inbox, Models & usage, Settings.');
    expect(compact).toContain('Settings sections (open_place): Voice, Audio devices, Voice engines.');
    const full = fullCapabilities(capabilities);
    expect(full).toContain('- check_audio: Checks the mic.');
    expect(full).toContain('In a chat (the browser agent');
    expect(full).toContain('- Audio devices');
  });

  it('keeps every core voice tool out of "More"', () => {
    for (const tool of VOICE_TOOLS) expect(TOOL_GROUPS[tool.name], tool.name).toBeDefined();
  });

  it('knows a group for every voice tool registered anywhere in the background', () => {
    // A drift guard: a feature that registers a voice tool and forgets a group still shows up (under More),
    // but the list reads better with one, so the test names it
    const root = path.resolve(import.meta.dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    const registered = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('registerVoiceTool(')) continue;
      for (const match of source.matchAll(/registerVoiceTool\(\{\s*declaration:\s*\{\s*name:\s*'([a-z_]+)'/g)) {
        registered.add(match[1]);
      }
    }
    expect(registered.size).toBeGreaterThan(10);
    const missing = [...registered].filter(name => !TOOL_GROUPS[name]);
    expect(missing).toEqual([]);
  });
});

describe('shortDescription', () => {
  it('keeps the first sentence and cuts a long one', () => {
    expect(shortDescription('Lists tabs. The one in front first.')).toBe('Lists tabs.');
    expect(shortDescription('Runs a routine (e.g. the brief) now. More.')).toBe('Runs a routine (e.g. the brief) now.');
    expect(shortDescription('x'.repeat(400))).toHaveLength(160);
  });
});

describe('findPlace', () => {
  const catalog = { places, settingsSections };
  it('finds places and sections by what the user said', () => {
    expect(findPlace(catalog, 'inbox')?.entry.id).toBe('inbox');
    expect(findPlace(catalog, 'open my inbox')?.entry.id).toBe('inbox');
    expect(findPlace(catalog, 'models')?.entry.id).toBe('models');
    expect(findPlace(catalog, 'audio devices')).toMatchObject({ kind: 'section', entry: { id: 'audio-devices' } });
    expect(findPlace(catalog, 'Settings › Audio devices')?.entry.id).toBe('audio-devices');
    expect(findPlace(catalog, 'voice settings')).toMatchObject({ kind: 'section', entry: { id: 'voice' } });
    expect(findPlace(catalog, 'settings')).toMatchObject({ kind: 'place', entry: { id: 'settings' } });
    expect(findPlace(catalog, 'home')?.entry.id).toBe('chat');
    expect(findPlace(catalog, 'the moon')).toBeNull();
    expect(findPlace(catalog, '')).toBeNull();
  });
});
