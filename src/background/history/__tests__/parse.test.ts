import { describe, expect, it } from 'vitest';
import { capTurns, MAX_TURN_CHARS } from '../parse/common';
import { classify } from '../parse/detect';
import { claudeCodeReader, claudeProjectFromPath, codexReader } from '../parse/jsonl';
import type { LineReader } from '../parse/jsonl';
import { parseExport, parseGemini, parseVscode, vscodeWorkspaceFolder } from '../parse/json';
import { readZipEntry } from '../parse/zip';

// Small synthetic sessions in each tool's shape; nothing here comes from anyone's real history
const T0 = Date.parse('2026-10-10T09:00:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function feed(reader: LineReader, lines: unknown[]) {
  for (const line of lines) reader.line(typeof line === 'string' ? line : JSON.stringify(line));
  return reader.end();
}

describe('classify', () => {
  it('tells the tools apart by where their files sit', () => {
    expect(classify('projects/-Users-me-code-app/0b1c2d3e-1111-2222-3333-444455556666.jsonl')?.tool).toBe(
      'claude-code',
    );
    expect(classify('projects/-Users-me-code-app/memory/notes.jsonl')).toBeNull();
    expect(classify('sessions/2026/10/10/rollout-2026-10-10T09-00-00-abc.jsonl')?.tool).toBe('codex');
    expect(classify('tmp/abc123/chats/session-2026-10-10-x.json')?.tool).toBe('gemini-cli');
    expect(classify('tmp/abc123/logs.json')?.tool).toBe('gemini-cli');
    expect(classify('workspaceStorage/ff00/chatSessions/s1.jsonl')?.tool).toBe('vscode');
    expect(classify('export/conversations.json')?.format).toBe('export-json');
    expect(classify('chatgpt-export-2026.zip')?.format).toBe('export-zip');
    expect(classify('settings.json')).toBeNull();
  });
});

describe('Claude Code', () => {
  it('keeps what the user and the assistant said, with the folder, branch and title', () => {
    const base = { sessionId: 'sess-1', cwd: '/Users/me/code/app', gitBranch: 'main' };
    const [conversation] = feed(claudeCodeReader('projects/-Users-me-code-app/sess-1.jsonl', T0), [
      { ...base, type: 'user', timestamp: iso(0), message: { role: 'user', content: 'Fix the login bug' } },
      {
        ...base,
        type: 'assistant',
        timestamp: iso(1),
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret thoughts' },
            { type: 'text', text: 'Looking at auth.ts' },
            { type: 'tool_use', name: 'Read', input: { path: 'auth.ts' } },
          ],
        },
      },
      {
        ...base,
        type: 'user',
        timestamp: iso(2),
        message: { role: 'user', content: [{ type: 'tool_result', content: 'HUGE FILE CONTENT' }] },
      },
      {
        ...base,
        type: 'assistant',
        timestamp: iso(3),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the token expired early.' }] },
      },
      { ...base, type: 'user', isMeta: true, timestamp: iso(4), message: { content: 'meta line' } },
      {
        ...base,
        type: 'user',
        timestamp: iso(5),
        message: { content: '<command-name>/clear</command-name>' },
      },
      { ...base, type: 'user', isSidechain: true, timestamp: iso(6), message: { content: 'subagent prompt' } },
      'not json at all',
      { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Login bug fix' },
    ]);
    expect(conversation.id).toBe('sess-1');
    expect(conversation.title).toBe('Login bug fix');
    expect(conversation.project).toBe('/Users/me/code/app');
    expect(conversation.branch).toBe('main');
    expect(conversation.startedAt).toBe(T0);
    expect(conversation.updatedAt).toBe(T0 + 3 * 60_000);
    expect(conversation.turns.map(turn => [turn.role, turn.text])).toEqual([
      ['user', 'Fix the login bug'],
      ['assistant', 'Looking at auth.ts\n\nFixed: the token expired early.'],
    ]);
    const all = JSON.stringify(conversation);
    for (const noise of ['secret thoughts', 'HUGE FILE', 'meta line', '/clear', 'subagent']) {
      expect(all).not.toContain(noise);
    }
  });

  it('finds the folder from the projects folder name when no line says it, and drops empty sessions', () => {
    expect(claudeProjectFromPath('projects/-Users-me-code-app/x.jsonl')).toBe('/Users/me/code/app');
    expect(feed(claudeCodeReader('projects/-a/x.jsonl', T0), [{ type: 'ai-title', aiTitle: 'Nothing' }])).toEqual([]);
  });
});

describe('Codex', () => {
  it('reads the session meta and the messages, without developer text or tool calls', () => {
    const [conversation] = feed(codexReader('sessions/2026/10/10/rollout-x.jsonl', T0), [
      {
        type: 'session_meta',
        timestamp: iso(0),
        payload: { id: 'codex-1', cwd: '/Users/me/code/api', git: { branch: 'feat/x' }, timestamp: iso(0) },
      },
      {
        type: 'response_item',
        timestamp: iso(0),
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SYSTEM RULES' }] },
      },
      {
        type: 'response_item',
        timestamp: iso(1),
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context>cwd stuff</environment_context>' },
            { type: 'input_text', text: 'Add rate limiting' },
          ],
        },
      },
      { type: 'response_item', timestamp: iso(2), payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      {
        type: 'response_item',
        timestamp: iso(3),
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a limiter.' }] },
      },
      { type: 'event_msg', timestamp: iso(1), payload: { type: 'user_message', message: 'Add rate limiting' } },
    ]);
    expect(conversation).toMatchObject({
      id: 'codex-1',
      tool: 'codex',
      project: '/Users/me/code/api',
      branch: 'feat/x',
    });
    expect(conversation.title).toBe('Add rate limiting');
    expect(conversation.turns.map(turn => turn.text)).toEqual(['Add rate limiting', 'Added a limiter.']);
    expect(JSON.stringify(conversation)).not.toMatch(/SYSTEM RULES|cwd stuff|shell/);
  });

  it('falls back to the event messages of older files', () => {
    const [conversation] = feed(codexReader('rollout-old.jsonl', T0), [
      { type: 'event_msg', timestamp: iso(1), payload: { type: 'user_message', message: 'Hello' } },
      { type: 'event_msg', timestamp: iso(2), payload: { type: 'agent_message', message: 'Hi' } },
    ]);
    expect(conversation.turns.map(turn => turn.role)).toEqual(['user', 'assistant']);
  });
});

describe('VS Code chat', () => {
  it('replays the .jsonl edit log into requests and responses', () => {
    const lines = [
      { kind: 0, v: { sessionId: 'vs-1', creationDate: T0, requests: [] } },
      { kind: 1, k: ['customTitle'], v: 'Refactor the parser' },
      {
        kind: 2,
        k: ['requests'],
        v: [
          {
            timestamp: T0 + 1000,
            message: { text: 'Split parse() in two' },
            response: [{ kind: 'toolInvocationSerialized' }, { value: 'Done: parseHead and parseBody.' }],
          },
        ],
      },
    ]
      .map(line => JSON.stringify(line))
      .join('\n');
    const [conversation] = parseVscode('ws/chatSessions/vs-1.jsonl', lines, '/Users/me/code/lib', T0);
    expect(conversation).toMatchObject({ id: 'vs-1', title: 'Refactor the parser', project: '/Users/me/code/lib' });
    expect(conversation.turns.map(turn => turn.text)).toEqual([
      'Split parse() in two',
      'Done: parseHead and parseBody.',
    ]);
  });

  it('reads the project from workspace.json', () => {
    expect(vscodeWorkspaceFolder('{"folder":"file:///Users/me/code/my%20lib"}')).toBe('/Users/me/code/my lib');
    expect(vscodeWorkspaceFolder('nope')).toBeNull();
  });
});

describe('Gemini CLI', () => {
  it('reads a chats/session file', () => {
    const [conversation] = parseGemini(
      'tmp/h/chats/session-1.json',
      JSON.stringify({
        sessionId: 'g-1',
        startTime: iso(0),
        lastUpdated: iso(5),
        messages: [
          { type: 'user', content: 'Plan the launch', timestamp: iso(0) },
          { type: 'gemini', content: 'Three steps.', timestamp: iso(1) },
          { type: 'info', content: 'noise' },
        ],
      }),
      T0,
    );
    expect(conversation).toMatchObject({ id: 'g-1', tool: 'gemini-cli', startedAt: T0, updatedAt: T0 + 5 * 60_000 });
    expect(conversation.turns.map(turn => turn.text)).toEqual(['Plan the launch', 'Three steps.']);
  });

  it('reads logs.json by session', () => {
    const conversations = parseGemini(
      'tmp/h/logs.json',
      JSON.stringify([
        { sessionId: 'a', type: 'user', message: 'first', timestamp: iso(0) },
        { sessionId: 'b', type: 'user', message: 'other', timestamp: iso(1) },
        { sessionId: 'a', type: 'user', message: 'second', timestamp: iso(2) },
      ]),
      T0,
    );
    expect(conversations.map(c => [c.id, c.turns.length])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });
});

const chatgptExport = [
  {
    id: 'cg-1',
    title: 'Pricing ideas',
    create_time: T0 / 1000,
    update_time: T0 / 1000 + 600,
    current_node: 'n3',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      n1: {
        parent: 'root',
        message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['system prompt'] } },
      },
      n2: {
        parent: 'n1',
        message: {
          author: { role: 'user' },
          create_time: T0 / 1000 + 10,
          content: { content_type: 'text', parts: ['How should we price it?'] },
        },
      },
      abandoned: {
        parent: 'n2',
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['an old branch'] } },
      },
      n3: {
        parent: 'n2',
        message: {
          author: { role: 'assistant' },
          create_time: T0 / 1000 + 20,
          content: { content_type: 'text', parts: ['Charge per seat.'] },
        },
      },
    },
  },
];

const claudeExport = [
  {
    uuid: 'ca-1',
    name: 'Hiring plan',
    created_at: iso(0),
    updated_at: iso(9),
    chat_messages: [
      {
        sender: 'human',
        text: 'Draft a hiring plan',
        content: [{ type: 'text', text: 'Draft a hiring plan' }],
        created_at: iso(0),
      },
      { sender: 'assistant', text: 'Hire two engineers.', content: [], created_at: iso(1) },
    ],
  },
];

describe('data exports', () => {
  it('reads ChatGPT along the branch the user last saw', () => {
    const [conversation] = parseExport(JSON.stringify(chatgptExport), T0);
    expect(conversation).toMatchObject({ id: 'cg-1', tool: 'chatgpt', title: 'Pricing ideas', startedAt: T0 });
    expect(conversation.turns.map(turn => turn.text)).toEqual(['How should we price it?', 'Charge per seat.']);
    expect(JSON.stringify(conversation)).not.toMatch(/old branch|system prompt/);
  });

  it('reads Claude.ai', () => {
    const [conversation] = parseExport(JSON.stringify(claudeExport), T0);
    expect(conversation).toMatchObject({ id: 'ca-1', tool: 'claude-ai', title: 'Hiring plan' });
    expect(conversation.turns.map(turn => turn.text)).toEqual(['Draft a hiring plan', 'Hire two engineers.']);
  });

  it('reads conversations.json out of a zip, stored or deflated', async () => {
    const text = JSON.stringify(claudeExport);
    for (const deflate of [false, true]) {
      const zip = await makeZip(
        [
          { name: 'users.json', data: '[]' },
          { name: 'conversations.json', data: text },
        ],
        deflate,
      );
      expect(await readZipEntry(zip, name => name === 'conversations.json')).toBe(text);
      expect(await readZipEntry(zip, name => name === 'missing.json')).toBeNull();
    }
  });
});

describe('size caps', () => {
  it('keeps the opening and the latest turns, and says what was left out', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      text: `turn ${i} ${'x'.repeat(1000)}`,
      at: null,
    }));
    const capped = capTurns(turns, 10_000);
    expect(capped[0].text.startsWith('turn 0')).toBe(true);
    expect(capped.at(-1)!.text.startsWith('turn 49')).toBe(true);
    expect(capped.some(turn => /turns left out/.test(turn.text))).toBe(true);
    expect(capped.reduce((sum, turn) => sum + turn.text.length, 0)).toBeLessThan(10_200);
  });

  it('cuts a long turn', () => {
    const [conversation] = feed(claudeCodeReader('projects/-a/s.jsonl', T0), [
      { type: 'user', timestamp: iso(0), message: { content: 'y'.repeat(MAX_TURN_CHARS * 3) } },
    ]);
    expect(conversation.turns[0].text.length).toBe(MAX_TURN_CHARS);
  });
});

/** A minimal zip writer for the test: stored or raw-deflated entries, no CRC check on reading. */
async function makeZip(files: { name: string; data: string }[], deflate: boolean): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = encoder.encode(file.data);
    const body = deflate
      ? new Uint8Array(
          await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
        )
      : raw;
    const name = encoder.encode(file.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(10, deflate ? 8 : 0, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[]);
}

describe('replaying a VS Code edit log from an untrusted file', () => {
  it('never reaches the object machinery through __proto__, prototype or constructor', () => {
    const lines = [
      { kind: 0, v: { requests: [] } },
      { kind: 1, k: ['__proto__', 'polluted'], v: 'yes' },
      { kind: 1, k: ['constructor', 'prototype', 'polluted'], v: 'yes' },
      { kind: 2, k: ['__proto__', 'list'], v: ['yes'] },
      { kind: 1, k: ['requests', '__proto__'], v: { polluted: 'yes' } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n');
    expect(() => parseVscode('ws/chatSessions/evil.jsonl', lines, null, T0)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).list).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });
});
