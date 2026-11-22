import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person, Workspace } from '@extension/storage';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    i18n: { getMessage: (key: string) => key },
    runtime: { id: 'test', getURL: (path: string) => path, onMessage: { addListener: () => undefined } },
    action: { setBadgeText: async () => undefined },
  });
});

// Made-up workspaces and people only
const ws = (id: string, name: string, google?: string): Workspace => ({
  id,
  name,
  about: '',
  keywords: [name.toLowerCase()],
  accounts: google ? { google } : {},
  createdAt: 0,
});
const WORKSPACES = [
  ws('orchid', 'Orchid Labs', 'sam@orchid-labs.example'),
  ws('harbor', 'Harbor', 'ada@harbor.example'),
];
const person = (name: string, workspaceIds: string[]) =>
  ({ id: name, name, nameKey: name.toLowerCase(), aliases: [], aliasKeys: [], workspaceIds }) as unknown as Person;
const PEOPLE = [person('Ada Obi', ['harbor']), person('Kunle Bello', ['harbor']), person('Tola Ade', ['orchid'])];

vi.mock('@extension/storage', async importOriginal => ({
  ...(await importOriginal<typeof import('@extension/storage')>()),
  workspaceStore: { list: async () => WORKSPACES },
  peopleStore: { list: async () => PEOPLE },
}));
vi.mock('../../voice/vocabulary', () => ({
  correctedText: async (text: string) => text,
  vocabularyHint: async () => '',
}));

const { MeetingManager } = await import('../manager');

let meeting: Record<string, unknown>;
let updates: { meeting: Record<string, unknown>[]; thread: Record<string, unknown>[] };
let manager: InstanceType<typeof MeetingManager>;
let account: string | null;

beforeEach(() => {
  updates = { meeting: [], thread: [] };
  account = null;
  meeting = { id: 'm1', threadId: 't1', tabId: 1, workspaceId: null };
  const meetings = {
    get: async () => meeting,
    update: async (_id: string, changes: Record<string, unknown>) => {
      updates.meeting.push(changes);
      Object.assign(meeting, changes);
    },
  };
  const threads = {
    update: async (_id: string, changes: Record<string, unknown>) => {
      updates.thread.push(changes);
    },
  };
  manager = new MeetingManager(meetings as never, threads as never, async () => undefined);
  (manager as unknown as { meetAccount: () => Promise<string | null> }).meetAccount = async () => account;
});

describe('placing a meeting in a workspace (docs/pm-desk.md, Part 3)', () => {
  it('puts it where most known participants belong, as a rule’s placing, with its notes chat', async () => {
    meeting.roster = ['Ada Obi', 'Kunle Bello', 'Tola Ade', 'Someone New'];
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([{ workspaceId: 'harbor', workspaceSetBy: 'rule' }]);
    expect(updates.thread).toEqual([{ workspaceId: 'harbor', workspaceSetBy: 'rule' }]);
  });

  it('comes after the typed topic and before the Google account', async () => {
    meeting.roster = ['Ada Obi', 'Kunle Bello'];
    account = 'sam@orchid-labs.example';
    await manager.placeInWorkspace('m1');
    expect(meeting.workspaceId).toBe('harbor');

    meeting = {
      id: 'm1',
      threadId: 't1',
      tabId: 1,
      workspaceId: null,
      roster: ['Ada Obi'],
      topic: 'Orchid Labs pricing',
      topicSource: 'user',
    };
    await manager.placeInWorkspace('m1');
    expect(meeting.workspaceId).toBe('orchid');
  });

  it('falls to the Google account when the participants do not settle it', async () => {
    meeting.roster = ['Ada Obi', 'Tola Ade'];
    account = 'sam@orchid-labs.example';
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([{ workspaceId: 'orchid', workspaceSetBy: 'rule' }]);
  });

  it('does nothing when nobody is known and no account says', async () => {
    meeting.roster = ['Someone New'];
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([]);
  });

  it('does not move a meeting that already has a workspace, except for a topic the user typed', async () => {
    meeting.roster = ['Ada Obi', 'Kunle Bello'];
    meeting.workspaceId = 'orchid';
    meeting.workspaceSetBy = 'rule';
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([]);
    meeting.topic = 'Harbor weekly';
    meeting.topicSource = 'user';
    await manager.placeInWorkspace('m1');
    expect(meeting).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'rule' });
  });

  it('never changes a workspace the user chose, not even for a topic they typed', async () => {
    meeting.roster = ['Ada Obi', 'Kunle Bello'];
    meeting.workspaceId = 'orchid';
    meeting.workspaceSetBy = 'avi';
    meeting.topic = 'Harbor weekly';
    meeting.topicSource = 'user';
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([]);
    expect(updates.thread).toEqual([]);
  });

  it('does not overwrite a workspace the user chooses while the call’s account is being read', async () => {
    meeting.roster = ['Someone New'];
    (manager as unknown as { meetAccount: () => Promise<string | null> }).meetAccount = async () => {
      // The user's click lands during the read
      Object.assign(meeting, { workspaceId: 'harbor', workspaceSetBy: 'avi' });
      return 'sam@orchid-labs.example';
    };
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([]);
    expect(updates.thread).toEqual([]);
    expect(meeting).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
  });

  it('does not read a call from the topic an invite carries', async () => {
    meeting.roster = [];
    meeting.topic = 'Harbor weekly';
    meeting.topicSource = 'calendar';
    await manager.placeInWorkspace('m1');
    expect(updates.meeting).toEqual([]);
  });
});
