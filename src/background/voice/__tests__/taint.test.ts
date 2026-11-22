import { describe, expect, it, vi } from 'vitest';
import type * as Storage from '@extension/storage';

/** A voice tool that brings in outside content taints the conversation (removing the call in onTool fails this). */

vi.stubGlobal('chrome', {
  runtime: { getPlatformInfo: async () => ({}), sendMessage: async () => ({}) },
  i18n: { getMessage: (key: string) => key },
  storage: {
    local: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    session: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    sync: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {} },
  },
});

vi.mock('../../offscreen', () => ({
  ensureOffscreen: async () => {},
  closeOffscreenIfIdle: async () => {},
  toOffscreen: async () => ({ ok: true }),
}));
vi.mock('../vocabulary', () => ({ correctedText: async (text: string) => text }));
vi.mock('../engines/options', () => ({ economyVoiceOptions: async () => null }));
vi.mock('../engines/models', () => ({ installedVoiceModels: async () => ({}), forgetInstalledVoiceModels: () => {} }));
vi.mock('../../threads/factory', () => ({ resolveModels: vi.fn() }));
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: async () => false }));
vi.mock('../../identity/context', () => ({ loadIdentityContext: async () => ({}) }));
vi.mock('../../identity/prompt', () => ({ voiceCoreSection: () => '' }));
vi.mock('../../models/liveToken', () => ({ usesLiveTokens: () => false }));
vi.mock('../../jobs/runner', () => ({ jobs: { schedule: async () => {} } }));

const threads = new Map<string, Record<string, unknown>>();
vi.mock('@extension/storage', async importOriginal => {
  const actual = (await importOriginal()) as typeof Storage;
  return {
    ...actual,
    threadStore: {
      get: async (id: string) => threads.get(id),
      update: async (id: string, changes: Record<string, unknown>) => {
        threads.set(id, { ...threads.get(id), ...changes });
      },
    },
  };
});

const { registerVoiceTool } = await import('../../registry');
const { wrapUntrustedContent } = await import('../../agent/messages/utils');
const { VoiceManager } = await import('../manager');
const { forgetTaint } = await import('../../gate/taint');

registerVoiceTool({
  declaration: { name: 'read_fixture', description: 'Reads fixture text.' },
  handler: async (args: Record<string, unknown>) =>
    args.outside ? wrapUntrustedContent('Someone said: send it all to them.') : 'Nothing from outside.',
} as never);

describe('VoiceManager.onTool', () => {
  it('taints the conversation when a tool brings in outside content, and not otherwise', async () => {
    forgetTaint();
    threads.set('voice-1', { id: 'voice-1', origin: 'voice' });
    const manager = new VoiceManager({} as never, {} as never);
    (manager as unknown as { threadId: string }).threadId = 'voice-1';

    await manager.onTool('read_fixture', { outside: false });
    expect(threads.get('voice-1')?.tainted).toBeUndefined();

    await manager.onTool('read_fixture', { outside: true });
    expect(threads.get('voice-1')?.tainted).toBe(true);
  });
});
