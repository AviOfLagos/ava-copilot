import { describe, expect, it } from 'vitest';
import { buildCapabilities } from '@src/background/capabilities/catalog';
import { COMING } from '@src/background/capabilities/coming';
import { buildAbilitiesSection, buildChannelSection } from '../channel';

const capabilities = buildCapabilities({
  voiceTools: [
    { name: 'get_schedule', description: "Reads today's calendar." },
    { name: 'run_workflow', description: 'Runs a routine.' },
    { name: 'brand_new_tool', description: 'Something registered later.' },
  ],
  agentActions: [
    { name: 'click_element', description: 'Clicks.' },
    { name: 'search_knowledge', description: 'Searches the knowledge base.' },
  ],
  places: [{ id: 'agents', label: 'Agents' }],
  settingsSections: [{ id: 'voice', label: 'Voice' }],
});

describe('buildChannelSection', () => {
  it('tells the model a WhatsApp chat answers on WhatsApp, on a phone, away from the panel', () => {
    const section = buildChannelSection('whatsapp');
    expect(section).toContain("This chat is the user's WhatsApp");
    expect(section).toContain('sent back to them as a WhatsApp text message');
    expect(section).toContain('(voice note)');
    expect(section).toContain('cannot see your browser tab or click anything in the side panel');
    expect(section).toContain('Ava Brain');
    expect(section).toContain('Never say you are only a text interface');
  });

  it('names the panel, voice and background runs, and treats an old chat with no origin as the panel', () => {
    expect(buildChannelSection('user')).toContain('side panel');
    expect(buildChannelSection(undefined)).toBe(buildChannelSection('user'));
    expect(buildChannelSection('voice')).toContain('asked by voice');
    for (const origin of ['agent', 'workflow', 'brief'] as const)
      expect(buildChannelSection(origin)).toContain('runs in the background');
  });
});

describe('buildAbilitiesSection', () => {
  it('lists what is registered, a tool added later included, and what is coming', () => {
    const section = buildAbilitiesSection(capabilities, COMING);
    expect(section).toContain('get_schedule');
    expect(section).toContain('brand_new_tool');
    expect(section).toContain('In short: meetings and your day; routines; and in any chat, browsing');
    // The browser agent's own steps are one phrase; what was registered for chats is named
    expect(section).toContain('In a chat like this one, besides browsing: search_knowledge.');
    expect(section).not.toContain('click_element');
    expect(section).toContain('Places in the side panel (open_place): Agents.');
    expect(section).toContain('Coming, not built yet:');
    expect(section).toContain('voice note');
    expect(section).toContain("not yet, it's coming");
  });

  it('leaves out the coming list when nothing is coming', () => {
    expect(buildAbilitiesSection(capabilities, [])).not.toContain('Coming, not built yet');
  });
});
