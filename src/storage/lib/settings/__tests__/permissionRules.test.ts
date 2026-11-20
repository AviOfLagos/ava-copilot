import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
});

const { canAllowAlways, pageScope, permissionRulesStore, toolScope } = await import('../permissionRules');

describe('pageScope', () => {
  it('is the host and the first path segment', () => {
    expect(pageScope('https://app.example.com/crm/leads/42')).toBe('app.example.com/crm');
    expect(pageScope('https://Example.com/')).toBe('example.com');
  });

  it('is one document or account on hosts of shared documents', () => {
    expect(pageScope('https://docs.google.com/spreadsheets/d/abc/edit#gid=0')).toBe(
      'docs.google.com/spreadsheets/d/abc',
    );
    expect(pageScope('https://docs.google.com/forms/d/xyz/viewform')).toBe('docs.google.com/forms/d/xyz');
    expect(pageScope('https://mail.google.com/mail/u/0/#inbox')).toBe('mail.google.com/mail/u/0');
    expect(pageScope('https://mail.google.com/mail/u/1/#inbox')).not.toBe(
      pageScope('https://mail.google.com/mail/u/0/'),
    );
  });

  it('is empty for addresses a rule cannot name', () => {
    expect(pageScope('http://example.com/app')).toBe('');
    expect(pageScope('chrome://settings')).toBe('');
    expect(pageScope('not a url')).toBe('');
  });
});

describe('canAllowAlways', () => {
  it('never covers paying, deleting or giving access', () => {
    expect(['send', 'publish', 'submit', 'tool'].every(canAllowAlways)).toBe(true);
    expect(['purchase', 'delete', 'permission', 'login', 'captcha'].some(canAllowAlways)).toBe(false);
  });
});

describe('permissionRulesStore', () => {
  beforeEach(async () => {
    for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
  });

  it('saves, finds, counts and removes a rule', async () => {
    const rule = await permissionRulesStore.allow({
      kind: 'send',
      scope: 'mail.google.com/mail',
      label: 'Send on Gmail',
    });
    expect(rule).not.toBeNull();
    expect(await permissionRulesStore.find('send', 'mail.google.com/mail')).toMatchObject({ id: rule!.id });
    expect(await permissionRulesStore.find('submit', 'mail.google.com/mail')).toBeNull();
    await permissionRulesStore.used(rule!.id, 42);
    expect((await permissionRulesStore.list())[0]).toMatchObject({ uses: 1, lastUsedAt: 42 });
    await permissionRulesStore.remove(rule!.id);
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });

  it('does not bring a removed rule back when a use is counted after it', async () => {
    const rule = await permissionRulesStore.allow({ kind: 'send', scope: 'b.example', label: 'b' });
    await permissionRulesStore.remove(rule!.id);
    await permissionRulesStore.used(rule!.id);
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });

  it('keeps one rule per kind and place', async () => {
    await permissionRulesStore.allow({ kind: 'send', scope: 'a.example', label: 'a' });
    await permissionRulesStore.allow({ kind: 'send', scope: 'a.example', label: 'a again' });
    expect(await permissionRulesStore.list()).toHaveLength(1);
  });

  it('refuses a rule for a kind that always asks, whatever the caller sends', async () => {
    expect(await permissionRulesStore.allow({ kind: 'delete', scope: 'a.example', label: 'x' })).toBeNull();
    expect(await permissionRulesStore.allow({ kind: 'send', scope: '', label: 'x' })).toBeNull();
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });

  it('names a tool by its hash, so a changed tool is asked about again', () => {
    expect(toolScope('c1', 'send_message', 'abcdef0123456789zz')).toBe('tool:c1/send_message@abcdef0123456789');
    expect(toolScope('c1', 'send_message', 'ffff')).not.toBe(toolScope('c1', 'send_message', 'abcd'));
  });
});
