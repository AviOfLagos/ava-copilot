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

const { canAllowAlways, pageScope, permissionRulesStore, teamScope, toolScope } = await import('../permissionRules');

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
    expect(['send', 'publish', 'submit', 'tool'].every(kind => canAllowAlways(kind))).toBe(true);
    expect(['purchase', 'delete', 'permission', 'login', 'captcha'].some(kind => canAllowAlways(kind))).toBe(false);
  });

  it('remembers only the two kinds of growth work that run inside a hard limit', () => {
    const scope = (action: string) => `team:ws/agent/${action}`;
    expect(canAllowAlways('team', scope('customer_issue'))).toBe(true);
    expect(canAllowAlways('team', scope('beta_grant'))).toBe(true);
    // Spending, a new channel, a new account and a plan change are always the user's own decision
    for (const action of ['spend', 'new_channel', 'new_account', 'plan_change', 'tool', 'post', 'outreach_email']) {
      expect(canAllowAlways('team', scope(action))).toBe(false);
    }
    // A team rule with no place, or a place that is not a team's, covers nothing
    expect(canAllowAlways('team')).toBe(false);
    expect(canAllowAlways('team', 'example.com/app')).toBe(false);
    expect(canAllowAlways('team', 'team:ws/agent/customer_issue/extra')).toBe(false);
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

  it('never keeps a team rule for spending, a new channel, a new account or a plan change', async () => {
    for (const action of ['spend', 'new_channel', 'new_account', 'plan_change'] as const) {
      const scope = teamScope('ws', 'agent', action);
      expect(await permissionRulesStore.allow({ kind: 'team', scope, label: action })).toBeNull();
      expect(await permissionRulesStore.find('team', scope)).toBeNull();
    }
    expect(await permissionRulesStore.list()).toHaveLength(0);
    const kept = await permissionRulesStore.allow({
      kind: 'team',
      scope: teamScope('ws', 'agent', 'customer_issue'),
      label: 'Issues from customers',
    });
    expect(kept).not.toBeNull();
    // One agent's rule is not another agent's, nor another product's
    expect(await permissionRulesStore.find('team', teamScope('ws', 'other', 'customer_issue'))).toBeNull();
    expect(await permissionRulesStore.find('team', teamScope('ws2', 'agent', 'customer_issue'))).toBeNull();
  });

  it('names a tool by its hash, so a changed tool is asked about again', () => {
    expect(toolScope('c1', 'send_message', 'abcdef0123456789zz')).toBe('tool:c1/send_message@abcdef0123456789');
    expect(toolScope('c1', 'send_message', 'ffff')).not.toBe(toolScope('c1', 'send_message', 'abcd'));
  });
});
