import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Inventory from '../inventory';
import type * as Channels from '../channels';
import type * as Abilities from '../abilities';
import type * as ChannelPrompts from '@src/background/agent/prompts/channel';
import type * as Sources from '@src/background/capabilities/sources';
import { enT } from '@src/background/skills/__tests__/en';

vi.mock('@extension/i18n', () => ({ t: enT }));

const chromeStub: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : chromeStub),
  apply: () => Promise.resolve(undefined),
});

let inventory: typeof Inventory;
let channels: typeof Channels;
let abilities: typeof Abilities;
let prompts: typeof ChannelPrompts;
let sources: typeof Sources;

// What needs the user at the screen, as listed in #134
const SCREEN_ONLY = ['open_place', 'check_audio', 'check_model', 'say_in_meeting'];
const AWAY = ['whatsapp', 'agent', 'routine'] as const;
const ORIGINS = { whatsapp: 'whatsapp', agent: 'agent', routine: 'workflow' } as const;

// Twenty things a person asks for from a phone or an agent: browse, read, remember, tasks, routines, drafts
const TWENTY = [
  'done',
  'go_to_url',
  'search_google',
  'click_element',
  'input_text',
  'read_page_text',
  'open_tab',
  'switch_tab',
  'fill_form',
  'remember',
  'search_chats',
  'search_knowledge',
  'task_add',
  'task_list',
  'task_done',
  'person_note',
  'run_workflow',
  'list_agents',
  'whatsapp_draft_reply',
  'what_can_you_do',
];

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub);
  await import('@src/background/registers');
  inventory = await import('../inventory');
  channels = await import('../channels');
  abilities = await import('../abilities');
  prompts = await import('@src/background/agent/prompts/channel');
  sources = await import('@src/background/capabilities/sources');
}, 120_000);

describe('the tools each channel is offered', () => {
  it('leaves the screen-only tools out of WhatsApp, agents and routines', () => {
    const all = inventory.builtChatActions();
    for (const channel of AWAY) {
      const names = channels.actionsForChannel(all, channel, { hasProduct: true }).map(action => action.name());
      for (const denied of SCREEN_ONLY) expect(names, `${denied} on ${channel}`).not.toContain(denied);
    }
  });

  it('leaves the panel list exactly as it was', () => {
    const all = inventory.builtChatActions();
    for (const facts of [{ hasProduct: true }, { hasProduct: false }]) {
      expect(channels.actionsForChannel(all, 'panel', facts)).toEqual(all);
    }
    // A voice-started chat is read in the panel, so it gets the panel's list
    expect(channels.channelOfOrigin('voice')).toBe('panel');
    expect(channels.channelOfOrigin(undefined)).toBe('panel');
  });

  it('keeps the growth team out of a chat with no product, and in when one is set', () => {
    const all = inventory.builtChatActions();
    for (const channel of AWAY) {
      const without = channels.actionsForChannel(all, channel, { hasProduct: false }).map(a => a.name());
      const withProduct = channels.actionsForChannel(all, channel, { hasProduct: true }).map(a => a.name());
      for (const name of channels.GROWTH_TOOLS) {
        expect(without, `${name} on ${channel} without a product`).not.toContain(name);
        expect(withProduct, `${name} on ${channel} with a product`).toContain(name);
      }
      // The way to set a product stays
      expect(without).toContain('update_product_profile');
    }
    expect(channels.GROWTH_TOOLS.size).toBe(14);
  });

  it('still offers twenty everyday tools on every channel, with a product set or not', () => {
    const all = inventory.builtChatActions();
    expect(TWENTY).toHaveLength(20);
    for (const channel of ['panel', ...AWAY] as const) {
      for (const hasProduct of [true, false]) {
        const names = new Set(channels.actionsForChannel(all, channel, { hasProduct }).map(a => a.name()));
        expect(
          TWENTY.filter(name => !names.has(name)),
          `${channel}, product ${hasProduct}`,
        ).toEqual([]);
      }
    }
  });

  it('keeps the actions that ask first on WhatsApp: the gate decides, not the list', () => {
    const names = new Set(
      channels.actionsForChannel(inventory.builtChatActions(), 'whatsapp', { hasProduct: true }).map(a => a.name()),
    );
    for (const asks of ['queue_for_approval', 'drive_share', 'whatsapp_draft_reply', 'request_spend', 'call_tool']) {
      expect(names.has(asks), asks).toBe(true);
    }
  });

  it('shows the same channels in the generated table as the lists use', () => {
    const rows = new Map(inventory.toolInventory().map(row => [row.name, row]));
    expect(rows.get('open_place')!.channels).toEqual(['panel', 'voice']);
    expect(rows.get('done')!.channels).toEqual(['panel', 'whatsapp', 'agent', 'routine']);
  });
});

describe('"what can you do?" on WhatsApp', () => {
  const facts = { hasProduct: false };

  it('tells a WhatsApp chat about real tools only, none of them the phone cannot use', () => {
    const everything = new Set(inventory.toolInventory().map(row => row.name));
    for (const channel of AWAY) {
      const section = prompts.buildAbilitiesSection(
        abilities.capabilitiesForOrigin(sources.currentCapabilities(), ORIGINS[channel], facts),
        [],
      );
      for (const denied of SCREEN_ONLY) expect(section, `${denied} on ${channel}`).not.toContain(denied);
      expect(section).not.toContain('Places in the side panel');
      const chatLine = /In a chat like this one, besides browsing: (.+)\./.exec(section)?.[1] ?? '';
      const named = chatLine.split(', ');
      expect(named.length).toBeGreaterThan(10);
      for (const name of named) {
        expect(everything.has(name), `${name} is a real tool`).toBe(true);
        expect(channels.chatActionAllowed(name, channel, facts), `${name} on ${channel}`).toBe(true);
      }
    }
  });

  it('tells the panel everything, as before', () => {
    const full = sources.currentCapabilities();
    expect(abilities.capabilitiesForOrigin(full, 'user', facts)).toEqual(full);
    expect(abilities.capabilitiesForOrigin(full, 'whatsapp', facts)).not.toEqual(full);
  });
});
