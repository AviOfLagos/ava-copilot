import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askHuman, dialogText, validateAsk } from '../keys/ask';
import { ensureMasker, maskerContent, sha256 } from '../keys/install';
import { applyMask, MASK_MARKER, type MaskReport, planMask, secretEntries, variants } from '../keys/mask-core';
import { parseList, parseReport, promptLine, runWithSecrets, vaultEnv } from '../keys/run';
import { agentName, createKeysServer } from '../keys/server';
import { fakeRunner, tempDir } from './helpers';

const SECRET = 'sup3r-Secret/Value+42=';
const LIST = `go-solar-me/local
  AGENT_SECRET   2026-11-13  import:.env
  DATABASE_URL   2026-11-13  import:.env
go-solar-me/prod
  DATABASE_URL   2026-11-13  import:.env
3 names`;

const report = (over: Partial<MaskReport> = {}): string =>
  JSON.stringify({
    marker: MASK_MARKER,
    exitCode: 0,
    signal: null,
    stdout: 'ok «AGENT_SECRET»\n',
    stderr: '',
    masked: { AGENT_SECRET: 1 },
    unmasked: [],
    truncated: false,
    timedOut: false,
    ...over,
  });

describe('masking', () => {
  it('treats everything as a secret except what offboard fixes and what Ava Brain sent', () => {
    const env = { HOME: '/Users/x', PATH: '/bin', __CF_USER_TEXT_ENCODING: '0x1F5', LANG: 'en_US.UTF-8', TERM: 'dumb', PWD: '/work', API_KEY: SECRET, EMPTY: '' };
    expect(secretEntries(env, '/work').map(e => e.name)).toEqual(['API_KEY']);
    // a vault secret may carry a pass-through name (offboard applies secrets after its allow-list)
    expect(secretEntries({ CI: 'secret-ci-token', TERM: 'xterm-256color', PWD: '/other' }, '/work').map(e => e.name)).toEqual(['CI', 'TERM', 'PWD']);
  });

  it('masks a value inside a longer base64 stream, as in an Authorization: Basic header', () => {
    const plan = planMask([{ name: 'PASS', value: SECRET }]);
    for (const user of ['a', 'ab', 'admin', 'admin:']) {
      const header = Buffer.from(`${user}:${SECRET}@tail`).toString('base64');
      const out = applyMask(`Authorization: Basic ${header}`, plan);
      expect(out).toContain('«PASS»');
      // what is left is only the few characters shared with the user name and the tail
      expect(out.replace(/«PASS»/, '').length).toBeLessThan(`Authorization: Basic ${header}`.length - 20);
    }
  });

  it('masks a value stored with a trailing newline when it is printed trimmed', () => {
    const plan = planMask([{ name: 'TOKEN', value: `${SECRET}\r\n` }]);
    expect(applyMask(`got ${SECRET}.`, plan)).toBe('got «TOKEN».');
  });

  it('masks the raw value and its common encodings', () => {
    const plan = planMask([{ name: 'API_KEY', value: SECRET }]);
    const b64 = Buffer.from(SECRET).toString('base64');
    const text = [SECRET, b64, b64.replace(/=+$/, ''), Buffer.from(SECRET).toString('base64url'), encodeURIComponent(SECRET), Buffer.from(SECRET).toString('hex'), JSON.stringify({ k: SECRET })].join('\n');
    const counts: Record<string, number> = {};
    const out = applyMask(text, plan, counts);
    for (const form of variants(SECRET)) expect(out).not.toContain(form);
    expect(out).toContain('«API_KEY»');
    expect(counts.API_KEY).toBeGreaterThanOrEqual(6);
  });

  it('replaces a longer value whole before a shorter one inside it', () => {
    const plan = planMask([
      { name: 'SHORT', value: 'abcd1234' },
      { name: 'LONG', value: 'xx-abcd1234-yy' },
    ]);
    expect(applyMask('a xx-abcd1234-yy b abcd1234', plan)).toBe('a «LONG» b «SHORT»');
  });

  it('reports values too short to mask instead of shredding the output', () => {
    const plan = planMask([{ name: 'PIN', value: '12' }]);
    expect(plan.unmasked).toEqual(['PIN']);
    expect(applyMask('port 12', plan)).toBe('port 12');
  });
});

describe('the masker process', () => {
  const dir = tempDir();
  const masker = join(dir.path, 'mask.mjs');
  beforeAll(async () => {
    await build({ entryPoints: [resolve(import.meta.dirname, '../keys/mask.ts')], outfile: masker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  });
  afterAll(() => dir.remove());

  const runMasker = (script: string, env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [masker, 'test-agent: check masking', '/bin/sh', '-c', script], {
      env: { HOME: dir.path, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    });
    return { raw: r.stdout + r.stderr, report: parseReport(r.stdout), status: r.status };
  };

  it('runs the command and returns no value, in any common form, on either stream', { timeout: 30_000 }, () => {
    const r = runMasker('echo "token=$API_KEY"; printf %s "$API_KEY" | base64; echo "$API_KEY" >&2; echo "short=$PIN"; printf "u:%s" "$API_KEY" | base64; exit 3', { API_KEY: SECRET, PIN: '7' });
    expect(r.raw).not.toContain(SECRET);
    expect(r.raw).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(r.report?.stdout).toContain('token=«API_KEY»');
    expect(r.report?.stderr).toContain('«API_KEY»');
    expect(r.report?.exitCode).toBe(3);
    expect(r.report?.masked.API_KEY).toBe(4);
    expect(r.report?.unmasked).toEqual(['PIN']);
    expect(r.status).toBe(3);
  });

  it('never returns part of a value cut off at the output limit', { timeout: 30_000 }, () => {
    // 400 000 bytes is the masker's cap: put the value across it
    const r = runMasker('head -c 399990 /dev/zero | tr "\\0" x; printf %s "$API_KEY"; head -c 1000 /dev/zero | tr "\\0" y', { API_KEY: SECRET });
    expect(r.report?.truncated).toBe(true);
    expect(r.raw).not.toContain(SECRET.slice(0, 6));
  });

  it('does not hang on a daemon that keeps the output open, and stops it', () => {
    const started = Date.now();
    // the daemon ignores SIGTERM: only SIGKILL stops it
    const r = runMasker('sh -c \'trap "" TERM; sleep 60\' & echo "bg=$!"; echo done', { API_KEY: SECRET });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.report?.stdout).toContain('done');
    const pid = Number(/bg=(\d+)/.exec(r.report?.stdout ?? '')?.[1]);
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        spawnSync('/bin/sleep', ['0.1']);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);

  it('refuses a relative command', () => {
    const r = spawnSync(process.execPath, [masker, 'x: y', 'sh', '-c', 'true'], { encoding: 'utf8', env: { PATH: '/bin' } });
    expect(parseReport(r.stdout)?.error).toMatch(/absolute/);
  });
});

describe('run_with_secrets', () => {
  const dir = tempDir();
  // A short path, like the real ~/.ava-keys/mask, so the approval prompt fits offboard's 200 characters
  const short = mkdtempSync('/tmp/ak-');
  const maskPath = join(short, 'mask');
  writeFileSync(maskPath, 'masker');
  const deps = (runner: ReturnType<typeof fakeRunner>) => ({ runner, maskPath, expectedMaskHash: sha256('masker'), home: dir.path, searchPath: '/usr/bin:/bin' });
  const req = { project: 'go-solar-me', env: 'local', command: 'printenv', args: ['AGENT_SECRET'], purpose: 'check the agent secret', agent: 'claude-code', cwd: dir.path };
  afterAll(() => {
    dir.remove();
    rmSync(short, { recursive: true, force: true });
  });

  it('reads names from the vault list', () => {
    const list = parseList(LIST);
    expect(list.get('go-solar-me/local')).toEqual(['AGENT_SECRET', 'DATABASE_URL']);
    expect(list.get('go-solar-me/prod')).toEqual(['DATABASE_URL']);
  });

  it('asks offboard-vault to start the masker with who, why and the absolute command', async () => {
    const runner = fakeRunner(call => (call.args[0] === 'list' ? { stdout: LIST } : { stdout: `${report()}\n` }));
    const result = await runWithSecrets({ ...req, only: ['AGENT_SECRET'] }, deps(runner));
    expect(result).toMatchObject({ approved: true, ran: true, exitCode: 0, stdout: 'ok «AGENT_SECRET»\n', masked: { AGENT_SECRET: 1 } });
    const run = runner.calls[1];
    expect(run.command).toBe('/usr/local/bin/offboard-vault');
    expect(run.args).toEqual(['run', '--project', 'go-solar-me', '--env', 'local', '--only', 'AGENT_SECRET', '--', maskPath, 'claude-code: check the agent secret', '/usr/bin/printenv', 'AGENT_SECRET']);
    // offboard's helper refuses NODE_* and friends; nothing of this process's environment goes along
    expect(Object.keys(run.options.env).sort()).toEqual(Object.keys(vaultEnv(dir.path, dir.path)).sort());
    expect(run.options.cwd).toBe(dir.path);
  });

  it('never says nothing ran once the command started, even when the result is lost', async () => {
    const started = JSON.stringify({ marker: MASK_MARKER, started: true });
    const runner = fakeRunner(call => (call.args[0] === 'list' ? { stdout: LIST } : { stdout: `${started}\n{"marker":"ava-ke`, timedOut: true, code: 143 }));
    const result = await runWithSecrets(req, deps(runner));
    expect(result).toMatchObject({ approved: true, ran: true, timedOut: true });
    expect(result.message).toMatch(/result was lost/);
  });

  it('passes on only offboard\'s own lines when nothing ran', async () => {
    const runner = fakeRunner(call =>
      call.args[0] === 'list'
        ? { stdout: LIST }
        : { code: 1, stderr: `node: something quoting ${SECRET}\nvault: The property 'options.env['X']' Received '${SECRET}'\nvault: refused: parent has NODE_X set\n` },
    );
    const result = await runWithSecrets(req, deps(runner));
    expect(result.message).toContain('vault: refused');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses a purpose with quotes that could fake extra prompt arguments', async () => {
    const runner = fakeRunner(() => new Error('must not run'));
    expect((await runWithSecrets({ ...req, purpose: 'x" "/usr/bin/true' }, deps(runner))).message).toMatch(/purpose may use/);
    expect(runner.calls).toHaveLength(0);
  });

  it('says nothing ran when Avi denies the prompt', async () => {
    const runner = fakeRunner(call =>
      call.args[0] === 'list' ? { stdout: LIST } : { code: 1, stderr: 'vault: not approved (denied); nothing was done\n' },
    );
    const result = await runWithSecrets(req, deps(runner));
    expect(result).toMatchObject({ approved: false, ran: false, exitCode: null, stdout: '' });
    expect(result.message).toMatch(/did not approve/);
  });

  it('redacts anything that still looks like a key', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const runner = fakeRunner(call => (call.args[0] === 'list' ? { stdout: LIST } : { stdout: report({ stdout: `leaked ${token}\n` }) }));
    const result = await runWithSecrets(req, deps(runner));
    expect(result.stdout).toBe('leaked «redacted: GitHub token»\n');
    expect(result.redacted).toEqual(['GitHub token']);
  });

  it('refuses before any prompt: unknown names, unknown env, a changed masker, a prompt too long', async () => {
    const runner = fakeRunner(call => (call.args[0] === 'list' ? { stdout: LIST } : new Error('must not run')));
    expect((await runWithSecrets({ ...req, only: ['NOPE'] }, deps(runner))).message).toMatch(/not in go-solar-me\/local: NOPE/);
    expect((await runWithSecrets({ ...req, env: 'staging' }, deps(runner))).message).toMatch(/nothing stored/);
    expect((await runWithSecrets(req, { ...deps(runner), expectedMaskHash: 'other' })).message).toMatch(/keys install/);
    expect((await runWithSecrets({ ...req, args: ['x'.repeat(120)] }, deps(runner))).message).toMatch(/too long/);
    expect(runner.calls.every(call => call.args[0] === 'list')).toBe(true);
  });

  it('refuses control characters that could fake the prompt text', () => {
    expect(() => promptLine('/m', 'a: b‮', '/bin/ls', [])).toThrow(/control or invisible/);
  });
});

describe('ask_human', () => {
  const req = { purpose: 'Approve the GitHub login', steps: [{ text: 'Open Brave' }, { text: 'Click Continue', target: 'css:button' }], agent: 'claude-code' };

  it('shows numbered steps with who asks and maps the buttons', async () => {
    const runner = fakeRunner(() => ({ stdout: 'Done\n' }));
    const result = await askHuman(req, runner);
    expect(result.answer).toBe('done');
    const call = runner.calls[0];
    expect(call.command).toBe('/usr/bin/osascript');
    // the text is an argument, never part of the script
    expect(call.args[1]).not.toContain('Open Brave');
    expect(call.args[3]).toBe(dialogText(req));
    expect(dialogText(req)).toContain('claude-code asks: Approve the GitHub login\n\n1. Open Brave\n2. Click Continue');
    expect((await askHuman(req, fakeRunner(() => ({ stdout: "I can't\n" })))).answer).toBe('cant');
    expect((await askHuman(req, fakeRunner(() => ({ stdout: 'timeout\n' })))).answer).toBe('timeout');
  });

  it('refuses empty, long or invisible-character steps', () => {
    expect(validateAsk({ ...req, steps: [] })).toMatch(/1 to 10 steps/);
    expect(validateAsk({ ...req, steps: [{ text: 'x'.repeat(141) }] })).toMatch(/step 1/);
    expect(validateAsk({ ...req, steps: [{ text: 'ok\nfake line' }] })).toMatch(/invisible/);
  });
});

describe('install and the MCP server', () => {
  const dir = tempDir();
  const packageDir = join(dir.path, 'pkg');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'ava-keys-mask.mjs'), '#!/usr/bin/env node\nconsole.log("mask")\n');
  afterAll(() => dir.remove());

  it('writes the masker read-only with a #! line to this node, once', () => {
    const first = ensureMasker({ packageDir, nodePath: '/opt/node', home: dir.path });
    expect(first.wrote).toBe(true);
    expect(statSync(first.path).mode & 0o777).toBe(0o500);
    expect(first.hash).toBe(sha256(maskerContent('console.log("mask")\n', '/opt/node')));
    expect(ensureMasker({ packageDir, nodePath: '/opt/node', home: dir.path }).wrote).toBe(false);
    expect(ensureMasker({ packageDir, nodePath: '/opt/node2', home: dir.path }).wrote).toBe(true);
  });

  it('cleans the agent name for the prompt', () => {
    expect(agentName('Claude Code')).toBe('claude-code');
    expect(agentName(undefined)).toBe('an-agent');
    expect(agentName('"; rm -rf /')).toBe('rm-rf');
  });

  it('serves run_with_secrets and ask_human, with the client name as the agent', async () => {
    const runner = fakeRunner(call => {
      if (call.command === '/usr/bin/osascript') return { stdout: 'Done\n' };
      return call.args[0] === 'list' ? { stdout: LIST } : { stdout: report() };
    });
    const server = createKeysServer({ runner, packageDir, nodePath: process.execPath, home: dir.path, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(b);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    expect(tools).toEqual(['ask_human', 'run_with_secrets']);

    const ran = await client.callTool({ name: 'run_with_secrets', arguments: { project: 'go-solar-me', env: 'local', command: '/usr/bin/true', purpose: 'test run', cwd: dir.path } });
    const ranText = (ran.content as { text: string }[])[0].text;
    expect(JSON.parse(ranText)).toMatchObject({ approved: true, ran: true });
    const vaultCall = runner.calls.find(call => call.args[0] === 'run')!;
    expect(vaultCall.args).toContain('claude-code: test run');

    const asked = await client.callTool({ name: 'ask_human', arguments: { purpose: 'Enter the 2FA code', steps: [{ text: 'Type the code from your phone' }] } });
    expect(JSON.parse((asked.content as { text: string }[])[0].text).answer).toBe('done');
    await client.close();
  });
});
