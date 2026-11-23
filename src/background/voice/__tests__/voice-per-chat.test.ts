import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Storage from '@extension/storage';

/**
 * Voice lives in a chat (docs/voice-per-chat.md): it talks in the chat it was started in, with that chat's history,
 * runs tasks there, pauses when the user leaves the tab, resumes when they come back, and moves when started in
 * another chat. Without a chat it starts a new one that knows the recent chats.
 */

const broadcasts: Record<string, unknown>[] = [];
vi.stubGlobal('chrome', {
  runtime: {
    getURL: (path: string) => `chrome-extension://ava/${path}`,
    getPlatformInfo: async () => ({}),
    sendMessage: async (message: Record<string, unknown>) => {
      broadcasts.push(message);
      return {};
    },
  },
  i18n: { getMessage: (key: string) => key },
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    session: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    sync: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {} },
  },
});

const sent: Record<string, unknown>[] = [];
vi.mock('../../offscreen', () => ({
  ensureOffscreen: async () => {},
  closeOffscreenIfIdle: async () => {},
  toOffscreen: async (message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: true };
  },
}));
vi.mock('../browser-tools', () => ({
  listFrequentSites: async () => '',
  listTabs: async () => '',
  openTab: async () => 'Opened.',
  readPage: async () => '',
  readScreen: async () => ({ text: '' }),
  switchTab: async () => 'Switched.',
}));
vi.mock('../vocabulary', () => ({ correctedText: async (text: string) => text }));

interface Thread {
  id: string;
  title: string;
  status: string;
  tags: string[];
  updatedAt: number;
  createdAt: number;
  origin?: string;
}
const state = {
  threads: [] as Thread[],
  messages: {} as Record<string, { actor: string; content: string }[]>,
  panels: {} as Record<number, { threadId: string; role: string }>,
};
const stored: [string, string, string][] = [];

vi.mock('../../threads/tabPanels', () => ({
  tabPanels: {
    entryOf: (tabId: number) => state.panels[tabId] ?? null,
    open: async (tabId: number, threadId: string) => {
      state.panels[tabId] = { threadId, role: 'home' };
      return null;
    },
  },
}));
vi.mock('../engines/options', () => ({ economyVoiceOptions: async () => null }));
vi.mock('../engines/self', () => ({
  aboutYouSection: () => '',
  economyModelOf: async () => ({}),
  providerName: async () => 'Gemini',
}));
vi.mock('../../threads/factory', () => ({ resolveModels: vi.fn() }));
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: async () => false }));
vi.mock('../../identity/context', () => ({ loadIdentityContext: async () => ({}) }));
vi.mock('../../identity/prompt', () => ({ voiceCoreSection: () => '' }));
vi.mock('../../models/liveToken', () => ({ usesLiveTokens: () => false }));
vi.mock('../../jobs/runner', () => ({ jobs: { schedule: async () => {} } }));

vi.mock('@extension/storage', async importOriginal => {
  const actual = (await importOriginal()) as typeof Storage;
  const list = async () => state.threads;
  return {
    ...actual,
    db: { threads: { orderBy: () => ({ reverse: () => ({ toArray: list }) }), toArray: list } },
    threadStore: {
      create: async () => {
        const thread = { id: 'new-1', title: 'Voice', status: 'idle', tags: ['voice'], updatedAt: 0, createdAt: 0 };
        state.threads.push(thread);
        return thread;
      },
      get: async (id: string) => state.threads.find(thread => thread.id === id),
      messages: async (id: string) => state.messages[id] ?? [],
      addMessage: async (thread: string, actor: string, content: string) => {
        stored.push([thread, actor, content]);
      },
      remove: async () => {},
    },
    personalityStore: {
      resolve: async () => actual.BUILTIN_PERSONALITIES[0],
      getState: async () => actual.EMPTY_PERSONALITIES,
      subscribe: () => () => {},
    },
    llmProviderStore: { getAllProviders: async () => ({ gemini: { type: 'gemini', apiKey: 'key' } }) },
    meetingSettingsStore: {
      getSettings: async () => ({ liveModel: 'gemini-live-test', liveEndpoint: 'wss://example.test/live' }),
    },
    generalSettingsStore: { getSettings: async () => ({ stylePrompt: '', assistantName: 'Ava' }) },
    voiceIdentityStore: { getSettings: async () => ({ liveVoice: 'Aoede', language: 'en-US' }) },
    voiceEngineSettingsStore: { getSettings: async () => ({}) },
    meetingStore: { list: async () => [], active: async () => [] },
  };
});

const { VoiceManager } = await import('../manager');

const sends: Record<string, unknown>[] = [];
const threads = {
  send: async (request: Record<string, unknown>) => {
    sends.push(request);
    return (request.threadId as string | null) ?? 'side-1';
  },
  holderOf: () => null,
};
const manager = () => new VoiceManager(threads as never, {} as never);
const starts = () => sent.filter(message => message.type === 'voice_start') as { options: Record<string, unknown> }[];
const chat = (id: string, title: string, status = 'idle'): Thread => ({
  id,
  title,
  status,
  tags: [],
  updatedAt: Date.now(),
  createdAt: 0,
});

beforeEach(() => {
  sent.length = 0;
  sends.length = 0;
  stored.length = 0;
  broadcasts.length = 0;
  state.threads = [chat('chat-a', 'Invoice'), chat('chat-b', 'Flights')];
  state.messages = {
    'chat-a': [
      { actor: 'user', content: 'Find the zebra invoice' },
      { actor: 'planner', content: 'Found it: 240 dollars' },
    ],
    'chat-b': [{ actor: 'user', content: 'Flights to London' }],
  };
  state.panels = { 10: { threadId: 'chat-a', role: 'home' }, 20: { threadId: 'chat-b', role: 'home' } };
});

afterEach(() => vi.useRealTimers());

describe('voice started in a chat', () => {
  it('talks in that chat, with its history, and writes the turns there', async () => {
    const voice = manager();
    const result = await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    expect(result.threadId).toBe('chat-a');
    expect(String(starts()[0].options.instructions)).toContain('Found it: 240 dollars');
    await voice.onTurn('How much was it?', '240 dollars');
    expect(stored).toEqual([
      ['chat-a', 'user', 'How much was it?'],
      ['chat-a', 'planner', '240 dollars'],
    ]);
    await voice.stop();
  });

  it('runs a task in the same chat, or in a linked one while the chat is busy', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    expect(await voice.onTool('run_browser_task', { task: 'Pay the zebra invoice' })).toContain('this chat');
    expect(sends[0]).toMatchObject({ threadId: 'chat-a', text: 'Pay the zebra invoice', tabId: 10 });
    state.threads[0].status = 'running';
    expect(await voice.onTool('do_task', { request: 'Draft a WhatsApp to Ada' })).toContain('linked chat');
    expect(sends[1]).toMatchObject({ threadId: null, fields: { voiceThreadId: 'chat-a' } });
    await voice.stop();
  });
});

describe('voice started without a chat', () => {
  it('starts a new chat on the tab that knows the recent chats', async () => {
    const voice = manager();
    const result = await voice.start(1, { tabId: 30 });
    expect(result.threadId).toBe('new-1');
    expect(state.panels[30]).toEqual({ threadId: 'new-1', role: 'home' });
    const instructions = String(starts()[0].options.instructions);
    expect(instructions).toContain('"Invoice"');
    expect(instructions).toContain('Found it: 240 dollars');
    expect(instructions).toContain('search_chats');
    await voice.stop();
  });
});

describe('leaving and coming back', () => {
  it('pauses on another tab and resumes in the same chat on coming back', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    await voice.tabMoved(20, 1);
    expect(voice.state).toBe('paused');
    expect(voice.running).toBe(false);
    expect(voice.currentThreadId).toBe('chat-a');
    expect(sent.some(message => message.type === 'voice_stop')).toBe(true);
    expect(broadcasts.at(-1)).toEqual({ type: 'voice_status', status: 'paused', threadId: 'chat-a' });

    await voice.tabMoved(10, 1);
    expect(voice.running).toBe(true);
    expect(starts()).toHaveLength(2);
    expect(stored).toContainEqual(['chat-a', 'system', 'voice_resumed']);
    expect(String(sent.at(-1)?.text)).toContain('picking up where you were');
    await voice.stop();
  });

  it('does not pause for a tab voice itself brought up', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    await voice.onTool('switch_tab', { tab_id: 20 });
    await voice.tabMoved(20, 1);
    expect(voice.state).not.toBe('paused');
    await voice.stop();
  });

  it('ends after ten minutes away, and the chat says so', async () => {
    vi.useFakeTimers();
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    await voice.tabMoved(20, 1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(voice.state).toBe('off');
    expect(voice.currentThreadId).toBeNull();
    expect(stored).toContainEqual(['chat-a', 'system', 'voice_endedAway']);
  });

  it('ends when its tab closes while paused', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    await voice.tabMoved(20, 1);
    await voice.tabClosed(10);
    expect(voice.state).toBe('off');
  });
});

describe('one conversation at a time', () => {
  it('moves to another chat, and the chat it left says where it went', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    const result = await voice.start(1, { threadId: 'chat-b', tabId: 20 });
    expect(result).toMatchObject({ ok: true, threadId: 'chat-b' });
    expect(voice.currentThreadId).toBe('chat-b');
    expect(stored).toContainEqual(['chat-a', 'system', 'voice_moved']);
    expect(String(starts()[1].options.instructions)).toContain('Flights to London');
    await voice.stop();
  });

  it('keeps the conversation on when the same chat starts it again', async () => {
    const voice = manager();
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    await voice.start(1, { threadId: 'chat-a', tabId: 10 });
    expect(starts()).toHaveLength(1);
    await voice.stop();
  });
});
