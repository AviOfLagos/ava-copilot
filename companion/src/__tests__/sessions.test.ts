import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionEventSchema } from '@protocol';
import type { SessionEvent } from '@protocol';
import { mapEveEvent, ndjson } from '../sessions/events';
import type { EngineState, SessionEngine } from '../sessions/eve';
import { dockerUp, fakeRunner, startTestBrain } from './helpers';

// Recorded from a real eve 0.75.1 session by the spike (companion/spike/eve-probe)
const recorded = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'spike', 'eve-probe', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

describe('mapEveEvent', () => {
  it('turns a recorded approval session into protocol events, one per eve event at most', () => {
    const raw = recorded('events-analyst.ndjson');
    const events = raw
      .map((event, index) => mapEveEvent(event, index))
      .filter((event): event is SessionEvent => Boolean(event));
    for (const event of events) expect(sessionEventSchema.safeParse(event).success).toBe(true);
    expect(events.map(event => event.type)).toEqual([
      'session.started',
      'turn.started',
      'tool.called',
      'approval.requested',
      'turn.waiting',
      'approval.resolved',
      'tool.result',
      'message.delta',
      'message',
      'turn.completed',
      'session.idle',
    ]);
    const approval = events.find(event => event.type === 'approval.requested');
    expect(approval).toMatchObject({
      approvals: [{ tool: 'danger', input: { to: 'boss@example.com' }, prompt: 'Approve Danger?' }],
    });
    const indexes = events.map(event => event.index);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(events.find(event => event.type === 'message')).toMatchObject({
      final: true,
      text: 'TOOL RESULT: sent to boss@example.com',
    });
  });

  it('skips what the extension does not need, and anything malformed', () => {
    expect(mapEveEvent({ type: 'step.started', data: {} }, 3)).toBeNull();
    expect(mapEveEvent(null, 0)).toBeNull();
    expect(mapEveEvent({ type: 'turn.failed', data: { turnId: 't', error: { message: 'boom' } } }, 1)).toEqual({
      type: 'turn.failed',
      index: 1,
      turnId: 't',
      message: 'boom',
    });
  });

  it('splits NDJSON across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    async function* chunks() {
      yield encoder.encode('{"a":1}\n{"b"');
      yield encoder.encode(':2}\n\n{"c":3}');
    }
    const lines: unknown[] = [];
    for await (const line of ndjson(chunks())) lines.push(line);
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

/** An engine that records what it was asked and streams a fixed session. */
function fakeEngine() {
  const calls: string[] = [];
  const engine: SessionEngine & { calls: string[] } = {
    calls,
    state: (): EngineState => ({ kind: 'eve', state: 'ready', message: null }),
    start: async () => {},
    stop: async () => {},
    create: async (profileId, message) => {
      calls.push(`create ${profileId} ${message}`);
      return 'wrun_1';
    },
    send: async (id, message) => void calls.push(`send ${id} ${message}`),
    answer: async (id, approvalId, approved, note) =>
      void calls.push(`answer ${id} ${approvalId} ${approved} ${note ?? ''}`),
    cancel: async id => void calls.push(`cancel ${id}`),
    async *events(_id, cursor) {
      const all: SessionEvent[] = [
        { type: 'session.started', index: 0 },
        { type: 'turn.started', index: 1, turnId: 'turn_0' },
        { type: 'message', index: 2, turnId: 'turn_0', text: 'hello', final: true },
      ];
      yield* all.filter(event => event.index >= cursor);
    },
  };
  return engine;
}

const profile = {
  id: 'writer',
  name: 'Writer',
  instructions: 'Write release notes.',
  tools: ['write_file', 'read_file', 'mcp_read'],
  mcpTools: ['notes/search'],
};
const model = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'llama3.2',
  apiKey: 'sk-local-secret-123456789',
};

describe('sessions over the protocol', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  it('starts a session as a profile, streams its events from a cursor, and relays answers', async () => {
    const engine = fakeEngine();
    test = await startTestBrain({ engine });
    await test.pair();
    const created = await test.api('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-session-1', profile, model, message: 'Draft the notes' }),
    });
    expect(await created.json()).toEqual({ ok: true, sessionId: 'wrun_1' });
    expect(engine.calls).toEqual(['create writer Draft the notes']);

    // The key stays in memory: never in the profiles file
    const saved = readFileSync(join(test.brain.config.dataDir, 'profiles.json'), 'utf8');
    expect(saved).toContain('Write release notes.');
    expect(saved).not.toContain('sk-local-secret');
    expect(await test.brain.registry.model('writer')).toMatchObject({ apiKey: model.apiKey });

    const stream = await test.api('/v1/sessions/wrun_1/events', { body: JSON.stringify({ cursor: 1 }) });
    expect(stream.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = (await stream.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(lines.map(line => line.index)).toEqual([1, 2]);

    await test.api('/v1/sessions/wrun_1/answer', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-answer-1', approvalId: 'aitxt-1', approved: false, note: 'Not now' }),
    });
    await test.api('/v1/sessions/wrun_1/cancel', { method: 'POST', body: '{}' });
    expect(engine.calls.slice(1)).toEqual(['answer wrun_1 aitxt-1 false Not now', 'cancel wrun_1']);
    expect((await test.api('/v1/sessions/unknown/events')).status).toBe(404);
    // Reads are POSTs too: a GET is not part of the API
    expect((await test.api('/v1/sessions/wrun_1/events', { method: 'GET' })).status).toBe(404);
  });

  it('gives the eve agent its profile and model, and runs only the tools the profile lists', async () => {
    test = await startTestBrain({ engine: fakeEngine() });
    await test.pair();
    await test.api('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-session-2', profile, model, message: 'x' }),
    });
    const internal = (path: string, body?: unknown) =>
      test.api(`/internal${path}`, {
        origin: null,
        token: test.brain.internalSecret,
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });

    expect(await (await internal('/profiles/writer')).json()).toMatchObject({
      profile: { instructions: 'Write release notes.' },
    });
    expect(await (await internal('/models/writer')).json()).toMatchObject({
      model: { model: 'llama3.2', apiKey: model.apiKey },
    });

    const wrote = await internal('/tools/write_file', {
      profileId: 'writer',
      input: { path: 'notes.md', content: '# Notes' },
    });
    expect(await wrote.json()).toMatchObject({ ok: true, output: { path: 'notes.md' } });
    const read = await internal('/tools/read_file', { profileId: 'writer', input: { path: 'notes.md' } });
    expect(await read.json()).toMatchObject({ output: { content: '# Notes' } });

    // Not on the profile's list
    expect((await internal('/tools/run_command', { profileId: 'writer', input: { command: 'ls' } })).status).toBe(403);
    expect(
      (await internal('/tools/gh_write', { profileId: 'writer', input: { args: ['issue', 'create'] } })).status,
    ).toBe(403);
    // On the list, but this MCP tool is not
    expect(
      (await internal('/tools/mcp_read', { profileId: 'writer', input: { server: 'notes', tool: 'delete_all' } }))
        .status,
    ).toBe(403);
    // Out of the workspace
    expect(
      (await internal('/tools/read_file', { profileId: 'writer', input: { path: '../profiles.json' } })).status,
    ).toBe(400);
    expect((await internal('/tools/read_file', { profileId: 'nobody', input: { path: 'x' } })).status).toBe(404);
    expect((await internal('/tools/format_disk', { profileId: 'writer', input: {} })).status).toBe(404);
  });

  it('runs a held tool only with the click, and builds only for an agent that may run commands', async () => {
    const run = fakeRunner(dockerUp);
    test = await startTestBrain({ engine: fakeEngine(), run });
    await test.pair();
    const poster = {
      ...profile,
      id: 'poster',
      tools: ['run_command', 'gh_write', 'mcp_call'],
      mcpTools: ['notes/post'],
      sandbox: { network: 'open' },
    };
    const designer = { ...profile, id: 'designer', tools: ['publish_artifact', 'write_file'] };
    for (const [index, each] of [poster, designer].entries()) {
      await test.api('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ requestId: `req-held-${index}`, profile: each, model, message: 'x' }),
      });
    }
    const internal = (path: string, body: unknown) =>
      test.api(`/internal${path}`, {
        origin: null,
        token: test.brain.internalSecret,
        method: 'POST',
        body: JSON.stringify(body),
      });

    // Without the click eve relays, nothing that posts, calls or reaches the network runs
    const issue = ['issue', 'create', '--repo', 'a/b', '--title', 't', '--body', 'b'];
    expect((await internal('/tools/gh_write', { profileId: 'poster', input: { args: issue } })).status).toBe(403);
    expect(
      (await internal('/tools/mcp_call', { profileId: 'poster', input: { server: 'notes', tool: 'post' } })).status,
    ).toBe(403);
    expect((await internal('/tools/run_command', { profileId: 'poster', input: { command: 'curl x' } })).status).toBe(
      403,
    );
    // The model cannot claim the click: approved only counts at the top of the call, set by the forwarder
    expect(
      (await internal('/tools/gh_write', { profileId: 'poster', input: { args: issue, approved: true } })).status,
    ).toBe(403);

    // A build runs a command, so an agent without run_command gives files instead
    const built = await internal('/tools/publish_artifact', {
      profileId: 'designer',
      input: { title: 'Page', kind: 'site', build: { command: 'cat ~/.ssh/id_rsa > out/x', outDir: 'out' } },
    });
    expect(built.status).toBe(403);
    expect(run.calls.some(call => call.args.join(' ').includes('id_rsa'))).toBe(false);
    expect(run.calls.some(call => call.command === 'gh')).toBe(false);
  });
});
