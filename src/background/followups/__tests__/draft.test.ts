import { beforeEach, describe, expect, it, vi } from 'vitest';

const task = {
  id: 'tsk_1',
  title: 'Send the login',
  ownerId: 'p1',
  ownerName: 'Ada Obi',
  due: '2026-11-27',
  source: { kind: 'meeting', id: 'm1' },
};
const store = new Map<string, unknown>();
const getTask = vi.fn();
const meetingGet = vi.fn();
const generatePlainText = vi.fn();
const overBudget = vi.fn();

vi.mock('@extension/storage', () => ({
  db: { meetings: { get: (id: string) => meetingGet(id) } },
  peopleStore: { get: async () => ({ id: 'p1', name: 'Ada Obi' }) },
  taskStore: { get: (id: string) => getTask(id) },
  stripTaskMarkers: (text: string) => text,
  followUpDraftStore: {
    get: async (id: string, key: string) => {
      const entry = store.get(id) as { key: string } | undefined;
      return entry && entry.key === key ? entry : null;
    },
    set: async (id: string, entry: unknown) => void store.set(id, entry),
  },
}));
vi.mock('../../llm/generate', () => ({ generatePlainText: (args: unknown) => generatePlainText(args) }));
vi.mock('../../models/light', () => ({ lightModel: async () => ({ chatModel: {}, local: false }) }));
vi.mock('../../threads/factory', () => ({ resolveModels: async () => ({ navigator: {} }) }));
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: () => overBudget() }));
vi.mock('../../agent/messages/utils', () => ({ wrapUntrustedContent: (text: string) => `<data>${text}</data>` }));

import { checkDraft, draftFor, templateDraft } from '../draft';

describe('follow-up draft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Sunday 22 Nov 2026
    vi.setSystemTime(new Date(2026, 10, 22, 10, 0));
    store.clear();
    getTask.mockReset().mockResolvedValue(task);
    meetingGet.mockReset().mockResolvedValue({ startedAt: new Date(2026, 10, 17, 9, 0).getTime() });
    generatePlainText.mockReset();
    overBudget.mockReset().mockResolvedValue(false);
  });

  it('words the template from the facts', () => {
    expect(templateDraft({ name: 'Ada', task: 'Send the login', from: "Tuesday's call", date: null })).toBe(
      `Hi Ada, checking on "Send the login" from Tuesday's call. Where has that got to?`,
    );
    expect(templateDraft({ name: 'Ada', task: 'Send the login', from: null, date: 'Friday' })).toBe(
      'Hi Ada, checking on "Send the login". It was due Friday. Where has that got to?',
    );
  });

  it('uses the template with no model reply, with from and date from the clock', async () => {
    overBudget.mockResolvedValue(true);
    const result = await draftFor('tsk_1');
    expect(result.byModel).toBe(false);
    expect(result.facts).toEqual({ name: 'Ada', task: 'Send the login', from: "Tuesday's call", date: 'Friday' });
    expect(result.text).toContain("from Tuesday's call. It was due Friday.");
    expect(generatePlainText).not.toHaveBeenCalled();
  });

  it('names an older call by its date', async () => {
    meetingGet.mockResolvedValue({ startedAt: new Date(2026, 10, 12, 9, 0).getTime() });
    overBudget.mockResolvedValue(true);
    expect((await draftFor('tsk_1')).facts.from).toBe('the call on 12 Nov');
  });

  it('falls back to the template when the model drops the name', async () => {
    generatePlainText.mockResolvedValue('Hello there, where is the login at the moment?');
    const result = await draftFor('tsk_1');
    expect(result.byModel).toBe(false);
    expect(result.text.startsWith('Hi Ada, checking on')).toBe(true);
  });

  it('keeps a good model reply, without quotes, and then serves it from the cache', async () => {
    generatePlainText.mockResolvedValue('"Hi Ada, how is the login coming along?"');
    const first = await draftFor('tsk_1');
    expect(first).toMatchObject({ text: 'Hi Ada, how is the login coming along?', byModel: true });
    expect(generatePlainText).toHaveBeenCalledTimes(1);
    const second = await draftFor('tsk_1');
    expect(second.text).toBe(first.text);
    expect(generatePlainText).toHaveBeenCalledTimes(1);
  });

  it('rejects links, markers and blank lines', () => {
    const facts = { name: 'Ada', task: 'x', from: null, date: null };
    expect(checkDraft('Hi Ada, see https://x.test please?', facts)).toBeNull();
    expect(checkDraft('Hi Ada, about tsk_abcdefgh, any news?', facts)).toBeNull();
    expect(checkDraft('Hi Ada,\n\nany news on it?', facts)).toBeNull();
    expect(checkDraft('Hi Ada', facts)).toBeNull();
  });
});
