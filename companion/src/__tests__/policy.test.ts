import { describe, expect, it } from 'vitest';
import { classifyGh, createGhRunner } from '../cli/gh';
import { createLogger, redact } from '../log';
import { RateLimiter } from '../http/ratelimit';
import { scanForSecrets } from '../security/secrets';
import { fakeRunner } from './helpers';

describe('RateLimiter', () => {
  it('lets a burst through, then says how long to wait, then refills', () => {
    let now = 0;
    const limiter = new RateLimiter({ pair: { capacity: 3, perMinute: 6 } }, () => now);
    expect([1, 2, 3].map(() => limiter.take('pair').ok)).toEqual([true, true, true]);
    const refused = limiter.take('pair');
    expect(refused).toEqual({ ok: false, retryAfterMs: 10_000 });
    now += 10_000;
    expect(limiter.take('pair').ok).toBe(true);
  });

  it('keeps groups and callers apart, and lets unknown groups through', () => {
    const limiter = new RateLimiter({ run: { capacity: 1, perMinute: 1 } }, () => 0);
    expect(limiter.take('run', 'a').ok).toBe(true);
    expect(limiter.take('run', 'b').ok).toBe(true);
    expect(limiter.take('run', 'a').ok).toBe(false);
    expect(limiter.take('other').ok).toBe(true);
  });
});

describe('gh allowlist', () => {
  it('lets reads through and marks writes', () => {
    expect(classifyGh(['issue', 'list', '--repo', 'a/b'])).toEqual({ ok: true, kind: 'read' });
    expect(classifyGh(['pr', 'view', '12', '--json', 'title'])).toEqual({ ok: true, kind: 'read' });
    expect(classifyGh(['repo', 'view'])).toEqual({ ok: true, kind: 'read' });
    expect(classifyGh(['issue', 'create', '--title', 't', '--body', 'b'])).toEqual({ ok: true, kind: 'write' });
  });

  it('refuses everything that writes code, administers or reads Mac files', () => {
    for (const args of [
      ['repo', 'create', 'x'],
      ['repo', 'delete', 'a/b'],
      ['pr', 'create'],
      ['pr', 'merge', '1'],
      ['pr', 'checkout', '1'],
      ['release', 'create', 'v1'],
      ['api', 'repos/a/b', '-X', 'DELETE'],
      ['auth', 'token'],
      ['secret', 'set', 'X'],
      ['issue', 'create', '--body-file', '/Users/me/.ssh/id_rsa'],
      ['issue', 'create', '--body-file=/etc/passwd'],
      ['issue', 'list', '--web'],
      ['push'],
      ['issue'],
    ]) {
      expect(classifyGh(args).ok, args.join(' ')).toBe(false);
    }
  });

  it('runs reads without a shell, with a minimal environment', async () => {
    const run = fakeRunner(() => ({ stdout: '[]' }));
    const gh = createGhRunner({ run, log: createLogger({}, { write: () => {} }) });
    const reply = await gh.run(['issue', 'list'], { approved: false });
    expect(reply).toMatchObject({ ok: true, kind: 'read', exitCode: 0, stdout: '[]' });
    expect(run.calls[0].command).toBe('gh');
    expect(run.calls[0].args).toEqual(['issue', 'list']);
    expect(Object.keys(run.calls[0].options.env).sort()).toEqual(
      [
        'GH_NO_UPDATE_NOTIFIER',
        'GH_PROMPT_DISABLED',
        'GH_SPINNER_DISABLED',
        'HOME',
        'LANG',
        'NO_COLOR',
        'PATH',
        'USER',
      ].filter(key => key !== 'USER' || process.env.USER),
    );
  });

  it('writes only with the click, and never with a secret in them', async () => {
    const run = fakeRunner(() => ({ stdout: 'https://github.com/a/b/issues/1' }));
    const gh = createGhRunner({ run, log: createLogger({}, { write: () => {} }) });
    const issue = ['issue', 'create', '--title', 'Bug', '--body', 'Steps to reproduce'];
    await expect(gh.run(issue, { approved: false })).rejects.toMatchObject({ kind: 'forbidden' });
    expect(run.calls).toHaveLength(0);
    const leaky = [
      'issue',
      'create',
      '--title',
      'Bug',
      '--body',
      'my key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    ];
    await expect(gh.run(leaky, { approved: true })).rejects.toThrow(/GitHub token/);
    expect(run.calls).toHaveLength(0);
    await expect(gh.run(issue, { approved: true })).resolves.toMatchObject({ kind: 'write', exitCode: 0 });
    expect(run.calls).toHaveLength(1);
  });

  it('treats a write that timed out as an unknown outcome', async () => {
    const gh = createGhRunner({
      run: fakeRunner(() => ({ timedOut: true, code: -1 })),
      log: createLogger({}, { write: () => {} }),
    });
    await expect(gh.run(['issue', 'comment', '1', '--body', 'hi'], { approved: true })).rejects.toMatchObject({
      kind: 'unknown_outcome',
    });
  });
});

describe('secrets', () => {
  it('finds common secrets and names them without quoting them', () => {
    const text = [
      'AKIAABCDEFGHIJKLMNOP',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'password = "hunter2hunter2"',
      'xoxb-1234567890-abcdefghij',
    ].join('\n');
    const kinds = scanForSecrets(text).map(finding => finding.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'AWS access key',
        'OpenAI or Anthropic key',
        'private key',
        'password or key assignment',
        'Slack token',
      ]),
    );
    expect(scanForSecrets('A normal issue about a broken button.')).toEqual([]);
  });

  it('redacts tokens, keys and codes from log text', () => {
    const line = redact(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 key sk-proj-abcdefghijklmnop code ABCD-EFGH api_key=supersecretvalue',
    );
    expect(line).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789|sk-proj|ABCD-EFGH|supersecretvalue/);
    expect(line).toContain('[redacted]');
  });

  it('logs JSON lines with only clean scalar fields', () => {
    const lines: string[] = [];
    const log = createLogger({ app: 't' }, { write: line => lines.push(line), level: 'info' });
    log.debug('hidden');
    log.info('hello', { token: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789', n: 3 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', app: 't', n: 3 });
    expect(entry.token).toBe('Bearer [redacted]');
  });
});
