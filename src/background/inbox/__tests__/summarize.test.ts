import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { InboxItem } from '@extension/storage';

const generateStructured = vi.fn();
vi.mock('../../llm/generate', () => ({ generateStructured: (...args: unknown[]) => generateStructured(...args) }));
const isOverDailyBudget = vi.fn().mockResolvedValue(false);
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: () => isOverDailyBudget() }));

// Imported after the mocks above so summarize.ts picks them up
const { summarizeMessageItem } = await import('../summarize');

let db: AviCopilotDb;
const model = vi.fn().mockResolvedValue({ provider: 'mock', modelName: 'mock' });

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'whatsapp-web|1',
  source: 'whatsapp-web',
  externalId: '1',
  kind: 'message',
  title: 'Jordan',
  body: 'raw snippet from the page',
  links: [],
  priority: 'normal',
  status: 'unread',
  snoozeUntil: null,
  workspaceId: null,
  agentId: null,
  runId: null,
  approval: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

beforeEach(async () => {
  db = new AviCopilotDb(`summarize-${crypto.randomUUID()}`);
  generateStructured.mockReset();
  isOverDailyBudget.mockReset().mockResolvedValue(false);
  await db.inbox.put(item());
});

describe('summarizeMessageItem', () => {
  it('wraps the snippet as untrusted content before the model ever sees it', async () => {
    generateStructured.mockResolvedValue({ output: { line: 'Asking about tomorrow', whyItMatters: '' } });
    await summarizeMessageItem(item(), { model }, db);
    const call = generateStructured.mock.calls[0][0];
    expect(JSON.stringify(call.messages)).toMatch(/untrusted/i);
    expect(JSON.stringify(call.messages)).toContain('raw snippet from the page');
  });

  it('replaces the body with the summary, keeping the title (the sender) untouched', async () => {
    generateStructured.mockResolvedValue({ output: { line: 'Asking about tomorrow', whyItMatters: '' } });
    await summarizeMessageItem(item(), { model }, db);
    const stored = await db.inbox.get('whatsapp-web|1');
    expect(stored!.title).toBe('Jordan');
    expect(stored!.body).toBe('Asking about tomorrow');
  });

  it('adds why it may matter on its own line when the model gives one', async () => {
    generateStructured.mockResolvedValue({
      output: { line: 'Asking about tomorrow', whyItMatters: 'needs an answer today' },
    });
    await summarizeMessageItem(item(), { model }, db);
    const stored = await db.inbox.get('whatsapp-web|1');
    expect(stored!.body).toBe('Asking about tomorrow\n\nWhy it may matter: needs an answer today');
  });

  it('leaves the raw snippet in place when the model call fails', async () => {
    generateStructured.mockRejectedValue(new Error('offline'));
    await summarizeMessageItem(item(), { model }, db);
    const stored = await db.inbox.get('whatsapp-web|1');
    expect(stored!.body).toBe('raw snippet from the page');
  });

  it("skips the model entirely once the day's budget is spent", async () => {
    isOverDailyBudget.mockResolvedValue(true);
    await summarizeMessageItem(item(), { model }, db);
    expect(generateStructured).not.toHaveBeenCalled();
    const stored = await db.inbox.get('whatsapp-web|1');
    expect(stored!.body).toBe('raw snippet from the page');
  });

  it('never touches an approval, a result or an alert', async () => {
    await summarizeMessageItem(item({ kind: 'approval' }), { model }, db);
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
