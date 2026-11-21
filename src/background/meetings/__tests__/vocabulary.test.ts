import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// The correction is tested on its own (src/background/voice/vocabulary); here only that meetings call it
const corrected = vi.fn(async (text: string, _options?: { workspaceId?: string | null }) =>
  text.replace('Illum', 'Ellum'),
);
vi.mock('../../voice/vocabulary', () => ({
  correctedText: (text: string, options?: { workspaceId?: string | null }) => corrected(text, options),
  vocabularyHint: async () => '',
}));

const { MeetingManager } = await import('../manager');

describe('meeting segments and the vocabulary', () => {
  let added: Record<string, unknown>[];
  let manager: InstanceType<typeof MeetingManager>;
  beforeEach(() => {
    added = [];
    corrected.mockClear();
    const meetings = {
      get: async () => ({
        id: 'm1',
        status: 'recording',
        startedAt: Date.now() - 60_000,
        threadId: 't1',
        warnings: [],
      }),
      addSegments: async (segments: Record<string, unknown>[]) => {
        added.push(...segments);
      },
      segments: async () => [],
      clearWarning: async () => undefined,
    };
    const threads = { get: async () => ({ workspaceId: 'ws-a' }) };
    manager = new MeetingManager(meetings as never, threads as never, async () => undefined);
    // Summaries are not what is tested here
    (manager as unknown as { maybeSummarize: () => Promise<void> }).maybeSummarize = async () => undefined;
  });

  it("stores caption lines corrected, with what was written kept in textRaw, in the meeting's workspace", async () => {
    await manager.onCaptions('m1', [
      { speaker: 'Ada', text: 'Illum AI is ready' },
      { speaker: 'Sam', text: 'Great, thanks' },
    ]);
    expect(added).toEqual([
      expect.objectContaining({ speaker: 'Ada', text: 'Ellum AI is ready', textRaw: 'Illum AI is ready' }),
      expect.objectContaining({ speaker: 'Sam', text: 'Great, thanks' }),
    ]);
    expect('textRaw' in added[1]).toBe(false);
    expect(corrected).toHaveBeenCalledWith('Illum AI is ready', { workspaceId: 'ws-a' });
  });

  it('does the same for the segments of a recorded chunk, which keep the original in textRaw', async () => {
    const segments = [
      { meetingId: 'm1', tStart: 0, tEnd: 4, speaker: 'Speaker 1', text: 'Illum AI is ready', chunkIndex: 0 },
      { meetingId: 'm1', tStart: 4, tEnd: 8, speaker: 'Speaker 1', text: 'Nothing to fix', chunkIndex: 0 },
    ];
    const result = await (
      manager as unknown as { corrected: (meeting: { id: string }, items: typeof segments) => Promise<typeof segments> }
    ).corrected({ id: 'm1' }, segments);
    expect(result[0]).toMatchObject({ text: 'Ellum AI is ready', textRaw: 'Illum AI is ready' });
    expect(result[1]).toBe(segments[1]);
  });
});
