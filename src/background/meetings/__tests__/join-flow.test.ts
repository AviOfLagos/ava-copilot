import { describe, expect, it, vi } from 'vitest';
import type { MeetingRecord, UpcomingEvent } from '@extension/storage';
import { JoinFlow } from '../join-flow';
import type { JoinFlowDeps, MeetingEvent } from '../join-flow';

const NOW = 1_800_000_000_000;
const URL = 'https://meet.google.com/abc-defg-hij';

function meetingRecord(changes: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: 'm1',
    threadId: 't1',
    tabId: 7,
    title: 'Meet',
    platform: 'Google Meet',
    url: URL,
    startedAt: NOW,
    endedAt: null,
    status: 'recording',
    source: 'captions',
    withMic: false,
    rollingSummary: '',
    summaryAt: 0,
    summaryUpTo: 0,
    blockSummaries: [],
    note: null,
    markdown: '',
    warnings: [],
    liveCaptions: [],
    live: 'off',
    chunksTotal: 0,
    chunksDone: 0,
    error: null,
    auto: true,
    ...changes,
  };
}

function setup(
  options: {
    start?: () => Promise<string>;
    event?: UpcomingEvent | null;
    segments?: number;
    chunks?: { total: number; troubled: number };
  } = {},
) {
  const meetings = new Map<string, MeetingRecord>();
  const events: MeetingEvent[] = [];
  let now = NOW;
  const deps: JoinFlowDeps = {
    start: vi.fn(
      options.start ??
        (async () => {
          meetings.set('m1', meetingRecord());
          return 'm1';
        }),
    ),
    meeting: async id => meetings.get(id),
    segmentCount: async () => options.segments ?? 0,
    chunkStats: async () => options.chunks ?? { total: 1, troubled: 0 },
    setTopic: vi.fn(async (id: string, topic: string, source: 'user' | 'calendar') => {
      const meeting = meetings.get(id);
      if (meeting) meetings.set(id, { ...meeting, topic, topicSource: source });
    }),
    addWarning: vi.fn(async (id: string, warning: MeetingRecord['warnings'][number]) => {
      const meeting = meetings.get(id);
      if (meeting) meetings.set(id, { ...meeting, warnings: [...meeting.warnings, warning] });
    }),
    calendarEvent: async () => options.event ?? null,
    emit: async event => {
      events.push(event);
    },
    platformOf: () => 'Google Meet',
    now: () => now,
  };
  return { flow: new JoinFlow(deps), deps, meetings, events, later: (ms: number) => (now += ms) };
}

describe('JoinFlow', () => {
  it('starts recording on join without waiting for any answer', async () => {
    const { flow, meetings, events, deps } = setup();
    const result = await flow.joined(7, URL);
    expect(result).toEqual({ ok: true, meetingId: 'm1' });
    expect(deps.start).toHaveBeenCalledWith(7);
    expect(meetings.get('m1')?.status).toBe('recording');
    expect(events).toEqual([
      { kind: 'started', meetingId: 'm1', platform: 'Google Meet', source: 'captions', askNote: true },
    ]);
    // Never answering changes nothing: it is still recording, with no topic
    expect(meetings.get('m1')?.topic).toBeUndefined();
  });

  it('takes the topic from the calendar and does not ask for a note then', async () => {
    const event = { id: 'e', title: 'Stage 2 sync', start: NOW, end: NOW + 1, joinUrl: URL };
    const { flow, meetings, events } = setup({ event });
    await flow.joined(7, URL);
    expect(meetings.get('m1')).toMatchObject({ topic: 'Stage 2 sync', topicSource: 'calendar' });
    expect(events[0]).toMatchObject({ kind: 'started', askNote: false });
  });

  it("adds the user's note as context, and an empty one changes nothing", async () => {
    const { flow, meetings, events } = setup();
    await flow.joined(7, URL);
    expect(await flow.addNote('m1', '   ')).toBe(false);
    expect(meetings.get('m1')?.topic).toBeUndefined();

    expect(await flow.addNote('m1', '  Hiring  plan\nwith Ada ')).toBe(true);
    expect(meetings.get('m1')).toMatchObject({
      topic: 'Hiring plan with Ada',
      topicSource: 'user',
      status: 'recording',
    });
    expect(events.at(-1)).toEqual({ kind: 'note_saved', meetingId: 'm1' });
  });

  it('says loudly when notes cannot start', async () => {
    const { flow, events } = setup({
      start: async () => {
        throw new Error('Click the Nex Copilot icon on the meeting tab');
      },
    });
    const result = await flow.joined(7, URL);
    expect(result.ok).toBe(false);
    expect(events).toEqual([
      {
        kind: 'start_failed',
        tabId: 7,
        platform: 'Google Meet',
        reason: 'Click the Nex Copilot icon on the meeting tab',
      },
    ]);
  });

  it('a failing alert never undoes the recording', async () => {
    const { deps } = setup();
    deps.emit = async () => {
      throw new Error('notifications are off');
    };
    expect(await new JoinFlow(deps).joined(7, URL)).toEqual({ ok: true, meetingId: 'm1' });
  });

  it('alerts once when captions-only notes catch nothing in time', async () => {
    const { flow, events, meetings, later } = setup();
    await flow.joined(7, URL);
    expect(await flow.checkCapturing('m1', 45)).toBe(false);
    later(46_000);
    expect(await flow.checkCapturing('m1', 45)).toBe(true);
    expect(meetings.get('m1')?.warnings).toEqual(['nothing_captured']);
    expect(events.at(-1)).toEqual({
      kind: 'nothing_captured',
      meetingId: 'm1',
      platform: 'Google Meet',
      reason: 'captions_off',
    });
    // Once is enough
    expect(await flow.checkCapturing('m1', 45)).toBe(false);
  });

  it('gives a call whose captions are on longer, since nobody may have spoken yet', async () => {
    const { flow, events, meetings, later } = setup({
      start: async () => {
        meetings.set('m1', meetingRecord({ captionsOn: true }));
        return 'm1';
      },
    });
    await flow.joined(7, URL);
    later(60_000);
    expect(await flow.checkCapturing('m1', 45)).toBe(false);
    later(61_000);
    expect(await flow.checkCapturing('m1', 45)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'nothing_captured', reason: 'no_captions' });
  });

  it('alerts on audio only when nothing is recorded or nothing can be written down', async () => {
    const audioMeeting = (chunks: { total: number; troubled: number }) => {
      const flow = setup({
        chunks,
        start: async () => {
          flow.meetings.set('m1', meetingRecord({ source: 'audio' }));
          return 'm1';
        },
      });
      return flow;
    };
    const silent = audioMeeting({ total: 0, troubled: 0 });
    await silent.flow.joined(7, URL);
    silent.later(50_000);
    expect(await silent.flow.checkCapturing('m1', 45)).toBe(true);
    expect(silent.events.at(-1)).toMatchObject({ reason: 'no_audio' });

    const failing = audioMeeting({ total: 4, troubled: 2 });
    await failing.flow.joined(7, URL);
    failing.later(50_000);
    expect(await failing.flow.checkCapturing('m1', 45)).toBe(true);
    expect(failing.events.at(-1)).toMatchObject({ reason: 'transcription' });

    // Recorded and waiting its turn to be written down: not an alarm
    const quiet = audioMeeting({ total: 3, troubled: 0 });
    await quiet.flow.joined(7, URL);
    quiet.later(50_000);
    expect(await quiet.flow.checkCapturing('m1', 45)).toBe(false);
  });

  it('stays quiet when captions are coming in, or the audio is recorded', async () => {
    const withCaptions = setup({ segments: 3 });
    await withCaptions.flow.joined(7, URL);
    withCaptions.later(120_000);
    expect(await withCaptions.flow.checkCapturing('m1', 90)).toBe(false);

    const audio = setup({
      start: async () => {
        audio.meetings.set('m1', meetingRecord({ source: 'audio' }));
        return 'm1';
      },
    });
    await audio.flow.joined(7, URL);
    audio.later(120_000);
    expect(await audio.flow.checkCapturing('m1', 90)).toBe(false);
    expect(audio.events[0]).toMatchObject({ kind: 'started', source: 'audio' });
  });

  it('reports a recorder failure only while recording', async () => {
    const { flow, events, meetings } = setup();
    await flow.joined(7, URL);
    await flow.recorderFailed('m1', 'disk full');
    expect(events.at(-1)).toEqual({
      kind: 'recorder_failed',
      meetingId: 'm1',
      platform: 'Google Meet',
      reason: 'disk full',
    });
    meetings.set('m1', { ...meetings.get('m1')!, status: 'done' });
    const count = events.length;
    await flow.recorderFailed('m1', 'late');
    expect(events.length).toBe(count);
  });
});
