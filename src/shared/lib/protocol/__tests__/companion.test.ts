import { describe, expect, it } from 'vitest';
import {
  agentProfileSchema,
  ARTIFACT_CSP,
  artifactCreateRequestSchema,
  COMPANION_EXTENSION_ORIGIN,
  errorReplySchema,
  healthReplySchema,
  isErrorReply,
  isSafeRelativePath,
  MAC_NODE_TYPES,
  modelConfigSchema,
  normalizePairingCode,
  sandboxProfileFor,
  sandboxRunRequestSchema,
  sessionEventSchema,
  STATUS_OF_KIND,
  studioPageHtml,
  toolDescriptorSchema,
} from '../companion';

describe('companion protocol', () => {
  it('pins the extension origin the companion answers', () => {
    expect(COMPANION_EXTENSION_ORIGIN).toBe('chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio');
  });

  it('reads pairing codes the way people type them', () => {
    expect(normalizePairingCode('abcd-2345')).toBe('ABCD-2345');
    expect(normalizePairingCode(' AB CD 23 45 ')).toBe('ABCD-2345');
    // 0, 1, I, L and O are not in the alphabet; the length is fixed
    expect(normalizePairingCode('ABCD-2340')).toBeNull();
    expect(normalizePairingCode('ABCI-2345')).toBeNull();
    expect(normalizePairingCode('ABC-2345')).toBeNull();
  });

  it('keeps paths inside the workspace', () => {
    expect(isSafeRelativePath('dist/index.html')).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', ''])
      expect(isSafeRelativePath(bad)).toBe(false);
  });

  it('names a routine sandbox by its agent, or the shared one', () => {
    expect(sandboxProfileFor('7d1c0a3e-1111-4abc-9def-0123456789ab')).toBe('7d1c0a3e-1111-4abc-9def-0123456789ab');
    expect(sandboxProfileFor(null)).toBe('routines');
    expect(sandboxProfileFor('Has Spaces')).toBe('routines');
  });

  it('checks sandbox runs and fills the default limits of a profile', () => {
    expect(
      sandboxRunRequestSchema.safeParse({ requestId: 'r1-step-x', profileId: 'routines', command: 'ls' }).success,
    ).toBe(true);
    expect(
      sandboxRunRequestSchema.safeParse({ requestId: 'r1-step-x', profileId: '../x', command: 'ls' }).success,
    ).toBe(false);
    expect(sandboxRunRequestSchema.safeParse({ requestId: 'short', profileId: 'a', command: 'ls' }).success).toBe(
      false,
    );
    const profile = agentProfileSchema.parse({ id: 'writer', name: 'Writer' });
    expect(profile.sandbox).toEqual({ network: 'none', cpus: 1, memoryMb: 1024, timeoutSec: 300 });
    expect(profile.tools).toEqual([]);
    expect(agentProfileSchema.safeParse({ id: 'w', name: 'W', tools: ['format_disk'] }).success).toBe(false);
  });

  it('accepts any OpenAI-compatible endpoint as a model', () => {
    const model = modelConfigSchema.parse({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.2',
    });
    expect(model.contextWindow).toBe(32_768);
    expect(modelConfigSchema.safeParse({ provider: 'x', baseUrl: 'not a url', model: 'm' }).success).toBe(false);
  });

  it('wants either files or a build for an artifact', () => {
    const base = { requestId: 'req-12345', profileId: 'writer', title: 'Page', kind: 'html' };
    expect(artifactCreateRequestSchema.safeParse({ ...base, files: { 'index.html': '<p>' } }).success).toBe(true);
    expect(
      artifactCreateRequestSchema.safeParse({ ...base, build: { command: 'pnpm build', outDir: 'dist' } }).success,
    ).toBe(true);
    expect(artifactCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      artifactCreateRequestSchema.safeParse({
        ...base,
        files: { 'a.html': 'x' },
        build: { command: 'x', outDir: 'dist' },
      }).success,
    ).toBe(false);
    expect(artifactCreateRequestSchema.safeParse({ ...base, files: { '../a.html': 'x' } }).success).toBe(false);
  });

  it('serves artifacts with no network and an opaque origin', () => {
    expect(ARTIFACT_CSP).toContain('sandbox allow-scripts');
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin');
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).not.toMatch(/https?:/);
  });

  it('escapes what goes into the Studio page', () => {
    const html = studioPageHtml({ id: 'abc', title: '<img src=x onerror=alert(1)>', entry: 'index.html"><script>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('index.html"><script>');
  });

  it('knows every session event the companion sends, and refuses others', () => {
    expect(
      sessionEventSchema.safeParse({ type: 'message', index: 3, turnId: 't', text: 'hi', final: true }).success,
    ).toBe(true);
    expect(
      sessionEventSchema.safeParse({
        type: 'approval.requested',
        index: 4,
        turnId: 't',
        approvals: [{ approvalId: 'a', callId: 'c', tool: 'gh_write', input: { args: [] }, prompt: 'Approve?' }],
      }).success,
    ).toBe(true);
    expect(
      sessionEventSchema.safeParse({ type: 'message', index: -1, turnId: 't', text: 'x', final: true }).success,
    ).toBe(false);
    expect(sessionEventSchema.safeParse({ type: 'shell.exec', index: 1 }).success).toBe(false);
  });

  it('maps error kinds to statuses and recognises error replies', () => {
    expect(STATUS_OF_KIND.auth).toBe(401);
    expect(STATUS_OF_KIND.rate_limit).toBe(429);
    const reply = { ok: false, error: { kind: 'unavailable', message: 'Docker is not running.' } };
    expect(isErrorReply(reply)).toBe(true);
    expect(errorReplySchema.safeParse({ ok: false, error: { kind: 'exploded', message: 'x' } }).success).toBe(false);
  });

  it('describes tools with a fingerprint and checks health replies', () => {
    expect(
      toolDescriptorSchema.safeParse({
        server: 's',
        name: 't',
        description: '',
        inputSchema: {},
        fingerprint: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      toolDescriptorSchema.safeParse({ server: 's', name: 't', description: '', inputSchema: {}, fingerprint: 'x' })
        .success,
    ).toBe(false);
    const health = {
      ok: true,
      protocol: 1,
      version: '0.1.0',
      companionId: 'abc',
      uptimeMs: 5,
      docker: { state: 'down', message: 'Docker is not running.', version: null, imageReady: false },
      engine: { kind: 'eve', state: 'ready', message: null },
      mcp: [],
      workflows: { active: 0, running: 0 },
    };
    expect(healthReplySchema.safeParse(health).success).toBe(true);
  });

  it('lists only kinds of step the Mac can run without the browser', () => {
    expect(MAC_NODE_TYPES).toContain('step.sandbox');
    expect(MAC_NODE_TYPES).not.toContain('step.browse');
    expect(MAC_NODE_TYPES).not.toContain('step.memory_search');
  });
});
