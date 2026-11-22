import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Registry from '../../registry';
import type * as Channels from '../channels';
import type * as Inventory from '../inventory';
import { enT } from '@src/background/skills/__tests__/en';

vi.mock('@extension/i18n', () => ({ t: enT }));

const chromeStub: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : chromeStub),
  apply: () => Promise.resolve(undefined),
});

const NAMES = ['get_schedule', 'get_brief', 'read_inbox', 'list_workspaces', 'list_connectors'];

let registry: typeof Registry;
let channels: typeof Channels;
let inventory: typeof Inventory;
const events: string[] = [];

// The chat as a WhatsApp message makes it: the actions it is offered, run against stand-ins for the services
function context() {
  return {
    taskId: 'whatsapp-thread',
    emitEvent: (_actor: unknown, _state: unknown, text: string) => events.push(text),
  };
}

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub);
  await import('@src/background/registers');
  registry = await import('../../registry');
  channels = await import('../channels');
  inventory = await import('../inventory');
  const { setServices } = await import('../../registry/services');
  const start = Date.now() + 3_600_000;
  setServices({
    calendar: {
      upcoming: async (hours: number) => [
        {
          id: 'a',
          title: 'Standup with the design team',
          start,
          end: start + 1_800_000,
          joinUrl: 'https://meet.example/x',
        },
        { id: 'b', title: `Review (${hours}h window)`, start: start + 7_200_000, end: start + 9_000_000, joinUrl: '' },
      ],
    },
    brief: { today: async () => 'Two meetings today. One approval waits.' },
    voice: { workspaceId: null },
  } as never);
}, 120_000);

function offered(channel: 'panel' | 'whatsapp' | 'agent' | 'routine') {
  const all = registry.registeredActions(context() as never);
  return channels.actionsForChannel(all, channel, { hasProduct: false });
}

async function ask(name: string, input: object = {}) {
  const action = offered('whatsapp').find(item => item.name() === name);
  expect(action, `${name} is offered on WhatsApp`).toBeDefined();
  return action!.call(input);
}

describe('read tools in chats', () => {
  it('offers all five on WhatsApp, in the panel, to agents and to routines', () => {
    for (const channel of ['panel', 'whatsapp', 'agent', 'routine'] as const) {
      const names = offered(channel).map(action => action.name());
      for (const name of NAMES) expect(names, `${name} on ${channel}`).toContain(name);
    }
  });

  it('answers "What\'s on my calendar today?" from a WhatsApp chat', async () => {
    const result = await ask('get_schedule', { intent: '' });
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toContain('Standup with the design team');
    expect(result.extractedContent).toContain('has a meeting link');
    // Invite titles are data, marked as such
    expect(result.extractedContent).toMatch(/untrusted/i);
    // The model's hours reach the calendar
    expect((await ask('get_schedule', { hours: 6 })).extractedContent).toContain('Review (6h window)');
  });

  it('reads the brief, the Inbox, the workspaces and the connectors without asking first', async () => {
    expect((await ask('get_brief')).extractedContent).toContain('One approval waits.');
    expect((await ask('read_inbox')).extractedContent).toContain('The Inbox is empty.');
    // A chat cannot open the panel, so the answers never tell it to call open_place
    const workspaces = (await ask('list_workspaces')).extractedContent ?? '';
    const connectors = (await ask('list_connectors')).extractedContent ?? '';
    expect(workspaces).not.toContain('open_place');
    expect(connectors).not.toContain('open_place');
  });

  it('shows them in the generated table for the chat channels and for voice', () => {
    const rows = new Map(inventory.toolInventory().map(row => [row.name, row]));
    for (const name of NAMES) {
      expect(rows.get(name)?.in, name).toBe('both');
      expect(rows.get(name)?.channels, name).toEqual(['panel', 'voice', 'whatsapp', 'agent', 'routine']);
    }
  });
});
