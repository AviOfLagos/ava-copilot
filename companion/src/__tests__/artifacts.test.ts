import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_CSP,
  artifactCreateReplySchema,
  artifactOpenReplySchema,
  STUDIO_SCRIPT,
  STUDIO_STYLE,
  STUDIO_TOKEN_TTL_MS,
} from '@protocol';
import { StudioKeys } from '../artifacts/store';
import { startTestBrain } from './helpers';

const PAGE =
  '<!doctype html><title>Demo</title><h1>Hi</h1><img src="https://example.com/x.png"><script>document.title="ran"</script>';

describe('StudioKeys', () => {
  it('trades a token once, for one artifact, before it expires', () => {
    let now = 0;
    const keys = new StudioKeys(() => now);
    const token = keys.issueToken('aaaaaaaaaaaaaaaa');
    expect(keys.redeem('bbbbbbbbbbbbbbbb', token)).toBeNull();
    // The wrong artifact spent it
    expect(keys.redeem('aaaaaaaaaaaaaaaa', token)).toBeNull();
    const second = keys.issueToken('aaaaaaaaaaaaaaaa');
    const viewKey = keys.redeem('aaaaaaaaaaaaaaaa', second)!;
    expect(viewKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.redeem('aaaaaaaaaaaaaaaa', second)).toBeNull();
    expect(keys.checkView('aaaaaaaaaaaaaaaa', viewKey)).toBe(true);
    expect(keys.checkView('bbbbbbbbbbbbbbbb', viewKey)).toBe(false);
    const late = keys.issueToken('aaaaaaaaaaaaaaaa');
    now += STUDIO_TOKEN_TTL_MS + 1;
    expect(keys.redeem('aaaaaaaaaaaaaaaa', late)).toBeNull();
  });
});

describe('artifacts and Avi Studio', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  async function publish() {
    const response = await test.api('/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-artifact-1',
        profileId: 'writer',
        title: 'Demo',
        kind: 'html',
        files: { 'index.html': PAGE },
      }),
    });
    expect(response.status).toBe(200);
    return artifactCreateReplySchema.parse(await response.json()).artifact;
  }

  it('serves an artifact read-only, sandboxed, with no network, through a one-time link', async () => {
    test = await startTestBrain();
    await test.pair();
    const artifact = await publish();
    const list = (await (await test.api('/v1/artifacts/list')).json()) as { artifacts: { id: string }[] };
    expect(list.artifacts.map(item => item.id)).toEqual([artifact.id]);

    const opened = artifactOpenReplySchema.parse(
      await (await test.api(`/v1/artifacts/${artifact.id}/open`, { method: 'POST', body: '{}' })).json(),
    );
    const url = new URL(opened.url);
    expect(url.origin).toBe(test.base);
    expect(url.pathname).toBe(`/studio/${artifact.id}`);
    const token = url.hash.slice(1);
    expect(token.length).toBeGreaterThanOrEqual(43);

    // The Studio page: no token needed to load it, a strict CSP that allows only its own script and style
    const page = await fetch(`${test.base}/studio/${artifact.id}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    const hash = (text: string) => createHash('sha256').update(text).digest('base64');
    expect(csp).toContain(`script-src 'sha256-${hash(STUDIO_SCRIPT)}'`);
    expect(csp).toContain(`style-src 'sha256-${hash(STUDIO_STYLE)}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain(`<script>${STUDIO_SCRIPT}</script>`);

    // Only the Studio page itself may trade the token, and only once
    const session = (origin: string) =>
      fetch(`${test.base}/studio/${artifact.id}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ token }),
      });
    expect((await session('https://evil.example')).status).toBe(403);
    const traded = await session(test.base);
    expect(traded.status).toBe(200);
    const { viewKey } = (await traded.json()) as { viewKey: string };
    expect((await session(test.base)).status).toBe(403);

    const file = await fetch(`${test.base}/view/${artifact.id}/${viewKey}/index.html`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toContain('sandbox allow-scripts');
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toMatch(/img-src 'self' data: blob:(;|$)/);
    expect(file.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe(PAGE);

    expect((await fetch(`${test.base}/view/${artifact.id}/${'k'.repeat(43)}/index.html`)).status).toBe(404);
    expect((await fetch(`${test.base}/view/${artifact.id}/${viewKey}/..%2Fmeta.json`)).status).toBe(400);
    expect((await fetch(`${test.base}/view/${artifact.id}/${viewKey}/missing.html`)).status).toBe(404);
  });

  it('refuses unsafe paths, a missing entry and the wrong kind', async () => {
    test = await startTestBrain();
    await test.pair();
    const create = (body: Record<string, unknown>) =>
      test.api('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({ requestId: `req-${Math.random()}`, profileId: 'writer', title: 'x', ...body }),
      });
    expect((await create({ kind: 'html', files: { '../x.html': 'x' } })).status).toBe(400);
    expect((await create({ kind: 'html', files: { 'page.html': 'x' } })).status).toBe(400);
    expect((await create({ kind: 'svg', files: { 'index.html': 'x' } })).status).toBe(400);
    expect((await create({ kind: 'svg', entry: 'logo.svg', files: { 'logo.svg': '<svg/>' } })).status).toBe(200);
  });

  it('builds an artifact in the sandbox and keeps only what the build made', async () => {
    test = await startTestBrain();
    await test.pair();
    await test.brain.sandbox.writeFile('writer', 'out/index.html', '<h1>built</h1>');
    const response = await test.api('/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-build-1',
        profileId: 'writer',
        title: 'Built',
        kind: 'site',
        build: { command: 'pnpm build', outDir: 'out' },
      }),
    });
    expect(response.status).toBe(200);
    const { artifact } = artifactCreateReplySchema.parse(await response.json());
    expect(artifact).toMatchObject({ kind: 'site', files: 1, entry: 'index.html' });
  });

  it('answers a repeated request with the first answer instead of making a second artifact', async () => {
    test = await startTestBrain();
    await test.pair();
    const first = await publish();
    const again = await test.api('/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-artifact-1',
        profileId: 'writer',
        title: 'Demo',
        kind: 'html',
        files: { 'index.html': PAGE },
      }),
    });
    expect(artifactCreateReplySchema.parse(await again.json()).artifact.id).toBe(first.id);
    expect(((await (await test.api('/v1/artifacts/list')).json()) as { artifacts: unknown[] }).artifacts).toHaveLength(
      1,
    );
  });
});
