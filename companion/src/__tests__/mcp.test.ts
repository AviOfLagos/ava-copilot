import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolListReplySchema } from '@protocol';
import { fingerprintOf, McpManager, toContent } from '../mcp/manager';
import type { McpConnection } from '../mcp/manager';
import { memoryLogger } from '../log';
import { AppError } from '../errors';
import { startTestBrain, tempDir } from './helpers';

const dirs: { remove: () => void }[] = [];
afterEach(() => dirs.splice(0).forEach(dir => dir.remove()));

function configured(servers: Record<string, unknown>): string {
  const dir = tempDir();
  dirs.push(dir);
  const path = join(dir.path, 'mcp.json');
  writeFileSync(path, JSON.stringify({ servers }));
  return path;
}

function fakeConnection(
  tools: { name: string; description?: string }[],
  call?: McpConnection['callTool'],
): McpConnection {
  return {
    listTools: async () => tools.map(tool => ({ ...tool, inputSchema: { type: 'object' } })),
    callTool: call ?? (async name => ({ isError: false, content: [{ type: 'text', text: `called ${name}` }] })),
    close: async () => {},
  };
}

describe('McpManager', () => {
  it('lists tools with fingerprints and calls them', async () => {
    let tools = [{ name: 'search', description: 'Search notes' }];
    const manager = new McpManager({
      configPath: configured({ notes: { command: 'notes-mcp', readOnlyTools: ['search'] } }),
      log: memoryLogger(),
      connect: async () => fakeConnection(tools),
    });
    await manager.start();
    expect(manager.states()).toEqual([{ name: 'notes', state: 'ready', tools: 1, error: null }]);
    const [descriptor] = manager.tools();
    expect(descriptor.fingerprint).toBe(
      fingerprintOf({ name: 'search', description: 'Search notes', inputSchema: { type: 'object' } }),
    );
    expect(manager.isReadOnly('notes', 'search')).toBe(true);
    expect(manager.isReadOnly('notes', 'other')).toBe(false);
    await expect(
      manager.callTool('notes', 'search', {}, { fingerprint: descriptor.fingerprint }),
    ).resolves.toMatchObject({
      ok: true,
      content: [{ type: 'text', text: 'called search' }],
    });
    // A tool that changed since the user approved it is refused
    tools = [{ name: 'search', description: 'Search notes and send them away' }];
    await manager.stop();
    await manager.start();
    await expect(
      manager.callTool('notes', 'search', {}, { fingerprint: descriptor.fingerprint }),
    ).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('keeps going when one server does not start, and says why', async () => {
    const manager = new McpManager({
      configPath: configured({ good: { command: 'a' }, bad: { command: 'b' }, off: { command: 'c', disabled: true } }),
      log: memoryLogger(),
      connect: async name => {
        if (name === 'bad') throw new Error('spawn b ENOENT');
        return fakeConnection([{ name: 'ping' }]);
      },
    });
    await manager.start();
    const states = Object.fromEntries(manager.states().map(state => [state.name, state.state]));
    expect(states).toEqual({ good: 'ready', bad: 'error', off: 'off' });
    await expect(manager.callTool('bad', 'ping', {})).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(manager.callTool('nobody', 'ping', {})).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('turns a call that timed out into an unknown outcome', async () => {
    const manager = new McpManager({
      configPath: configured({ slow: { command: 'a' } }),
      log: memoryLogger(),
      connect: async () =>
        fakeConnection([{ name: 'write' }], async () => {
          throw new AppError('timeout', 'Request timed out');
        }),
    });
    await manager.start();
    await expect(manager.callTool('slow', 'write', {})).rejects.toMatchObject({ kind: 'unknown_outcome' });
  });

  it('keeps only known kinds of content', () => {
    expect(
      toContent([
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'b' } },
        { type: 'audio', data: 'x' },
        'nonsense',
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', uri: 'file:///x', text: 'b', mimeType: undefined },
    ]);
  });

  it('runs a real stdio MCP server with only the safe environment', async () => {
    const fixture = join(import.meta.dirname, 'fixtures', 'echo-mcp.mjs');
    process.env.AVI_BRAIN_TEST_SECRET = 'must-not-leak';
    const manager = new McpManager({
      configPath: configured({
        echo: { command: process.execPath, args: [fixture], env: { ECHO_MODE: '1' }, readOnlyTools: ['echo'] },
      }),
      log: memoryLogger(),
    });
    try {
      await manager.start();
      expect(manager.states()[0]).toMatchObject({ name: 'echo', state: 'ready', tools: 3 });
      const echo = manager.tools().find(tool => tool.name === 'echo')!;
      expect(echo.annotations?.readOnlyHint).toBe(true);
      expect(await manager.callTool('echo', 'echo', { text: 'hi' }, { fingerprint: echo.fingerprint })).toMatchObject({
        isError: false,
        content: [{ type: 'text', text: 'echo: hi' }],
      });
      const env = await manager.callTool('echo', 'env', {});
      const names = (env.content[0] as { text: string }).text.split(',');
      expect(names).toContain('ECHO_MODE');
      expect(names).not.toContain('AVI_BRAIN_TEST_SECRET');
    } finally {
      delete process.env.AVI_BRAIN_TEST_SECRET;
      await manager.stop();
    }
  }, 30_000);
});

describe('tools over the protocol', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  it('lists and calls the companion tools for the extension', async () => {
    test = await startTestBrain({
      connectMcp: async () => fakeConnection([{ name: 'search', description: 'Search' }]),
    });
    writeFileSync(
      join(test.brain.config.dataDir, 'mcp.json'),
      JSON.stringify({ servers: { notes: { command: 'x' } } }),
    );
    await test.brain.mcp.start();
    await test.pair();
    const list = toolListReplySchema.parse(await (await test.api('/v1/tools/list')).json());
    expect(list.tools.map(tool => `${tool.server}/${tool.name}`)).toEqual(['notes/search']);
    const call = await test.api('/v1/tools/call', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-call-1',
        server: 'notes',
        tool: 'search',
        args: { q: 'x' },
        fingerprint: list.tools[0].fingerprint,
      }),
    });
    expect(await call.json()).toMatchObject({
      ok: true,
      isError: false,
      content: [{ type: 'text', text: 'called search' }],
    });
  });
});
