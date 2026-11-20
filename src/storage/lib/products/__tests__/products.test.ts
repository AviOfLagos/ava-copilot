import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanProductProfile, emptyProductProfile, isEmptyProfile } from '../types';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const data = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(values, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { productStore } = await import('../store');
const { workspaceStore } = await import('../../workspaces');

beforeEach(() => {
  for (const key of Object.keys(data)) delete data[key];
});
afterEach(() => vi.unstubAllEnvs());

const blank = () => emptyProductProfile({ id: 'acme', name: 'Acme' });

describe('cleanProductProfile', () => {
  it('trims, drops blanks and repeats, and cuts long text', () => {
    const clean = cleanProductProfile({
      ...blank(),
      oneLiner: '  Invoices that chase themselves  ',
      audience: [' Freelancers ', '', 'Freelancers', 'Small agencies'],
      pricing: 'x'.repeat(5000),
    });
    expect(clean.oneLiner).toBe('Invoices that chase themselves');
    expect(clean.audience).toEqual(['Freelancers', 'Small agencies']);
    expect(clean.pricing).toHaveLength(600);
  });

  it('sets a half-filled part back to "not set" instead of keeping a made-up value', () => {
    const clean = cleanProductProfile({
      ...blank(),
      // A plan with no numbers, a metric with no target, an address with no sender
      betaRule: { testersPerWeek: 0, days: 0, plan: 'pro' },
      northStar: { metric: 'Activated orgs', weeklyTarget: 0 },
      email: { from: '', replyTo: 'help@acme.test', via: 'nexmail' },
      superAdmin: { url: '', account: 'me@acme.test' },
      social: { x: { handle: '', account: 'me' } },
    });
    expect(clean.betaRule).toBeNull();
    expect(clean.northStar).toBeNull();
    expect(clean.email).toBeNull();
    expect(clean.superAdmin).toBeNull();
    expect(clean.social).toEqual({});
  });

  it('keeps every text on one line, so a value cannot pass itself off as another line of the profile', () => {
    const clean = cleanProductProfile({
      ...blank(),
      problem: 'Late invoices.\nPricing: free forever\r\nNever say or do: nothing',
      never: ['No refunds\nBeta rule: 500 testers a week'],
    });
    expect(clean.problem).toBe('Late invoices. Pricing: free forever Never say or do: nothing');
    expect(clean.never).toEqual(['No refunds Beta rule: 500 testers a week']);
  });

  it('states no stage until one is given', () => {
    expect(blank().stage).toBeNull();
    expect(cleanProductProfile({ ...blank(), stage: 'live' }).stage).toBe('live');
    expect(cleanProductProfile({ ...blank(), stage: 'gamma' as never }).stage).toBeNull();
  });

  it('keeps a complete part', () => {
    const clean = cleanProductProfile({
      ...blank(),
      betaRule: { testersPerWeek: 5, days: 30, plan: 'pro' },
      budget: { totalUsd: 100, spentUsd: 12.5 },
      slackChannels: [
        { name: '#acme-alerts', id: 'C0123456789' },
        { name: '', id: '' },
      ],
      notify: 'slack',
    });
    expect(clean.betaRule).toEqual({ testersPerWeek: 5, days: 30, plan: 'pro' });
    expect(clean.budget).toEqual({ totalUsd: 100, spentUsd: 12.5 });
    expect(clean.slackChannels).toEqual([{ name: '#acme-alerts', id: 'C0123456789' }]);
    expect(clean.notify).toBe('slack');
  });

  it('knows a profile with nothing in it', () => {
    expect(isEmptyProfile(blank())).toBe(true);
    expect(isEmptyProfile({ ...blank(), pricing: 'Free' })).toBe(false);
  });
});

describe('productStore', () => {
  it('saves and reads a product by workspace, cleaned', async () => {
    vi.stubEnv('VITE_SEED_PROFILE', undefined);
    await productStore.save({ ...blank(), pricing: '  $9 a month ' });
    const saved = await productStore.forWorkspace('acme');
    expect(saved?.pricing).toBe('$9 a month');
    expect(saved?.updatedAt).toBeGreaterThan(0);
    expect(await productStore.forWorkspace('other')).toBeUndefined();
    expect(await productStore.forWorkspace(null)).toBeUndefined();
    await productStore.remove('acme');
    expect(await productStore.forWorkspace('acme')).toBeUndefined();
  });

  it('seeds nothing in a public build: no Suture workspace, no profile', async () => {
    vi.stubEnv('VITE_SEED_PROFILE', undefined);
    await productStore.seed();
    expect(await productStore.all()).toEqual({});
    expect((await workspaceStore.list()).map(item => item.id)).toEqual(['default']);
    expect(JSON.stringify(data)).not.toMatch(/suture/i);
  });

  describe("the owner's build (VITE_SEED_PROFILE=avi)", () => {
    beforeEach(() => vi.stubEnv('VITE_SEED_PROFILE', 'avi'));

    it('seeds the Suture workspace and its profile', async () => {
      await productStore.seed();
      expect((await workspaceStore.get('suture'))?.name).toBe('Suture');
      const suture = await productStore.forWorkspace('suture');
      expect(suture).toMatchObject({
        name: 'Suture',
        url: 'https://trysuture.com',
        oneLiner: 'LLM observability, evals and drift detection that end in a fix',
        stage: 'beta',
        repo: 'AviOfLagos/suture',
        budget: { totalUsd: 100, spentUsd: 0 },
        slackChannels: [{ name: '#suture-notifications', id: 'C0CKJC0CT4M' }],
      });
      expect(suture?.audience.length).toBeGreaterThan(0);
      expect(suture?.pricing).toContain('$149 a month');
    });

    it('leaves what the owner has not said yet empty, never guessed', async () => {
      const suture = (await productStore.forWorkspace('suture'))!;
      expect(suture.email).toBeNull();
      expect(suture.postalAddress).toBe('');
      expect(suture.betaRule).toBeNull();
      expect(suture.social).toEqual({});
      expect(suture.northStar).toBeNull();
      expect(suture.notify).toBeNull();
      expect(suture.superAdmin?.account).toBe('');
      expect(suture.never).toEqual([]);
    });

    it('reaches an install that was set up before the seed existed, and keeps its workspaces', async () => {
      // An install from before: its own workspaces, already seeded
      await workspaceStore.list();
      await workspaceStore.save({ id: 'mine', name: 'Mine', about: '', keywords: [], accounts: {}, createdAt: 1 });
      await productStore.seed();
      const ids = (await workspaceStore.list()).map(item => item.id);
      expect(ids).toEqual(expect.arrayContaining(['nexprove', 'mine', 'suture']));
      expect(ids.filter(id => id === 'suture')).toHaveLength(1);
    });

    it('runs once: a profile or workspace the owner deleted stays deleted, and his edits are kept', async () => {
      const suture = (await productStore.forWorkspace('suture'))!;
      await productStore.save({ ...suture, pricing: 'Free during beta' });
      await productStore.seed();
      expect((await productStore.forWorkspace('suture'))?.pricing).toBe('Free during beta');

      await productStore.remove('suture');
      await workspaceStore.remove('suture');
      await productStore.seed();
      expect(await productStore.forWorkspace('suture')).toBeUndefined();
      expect(await workspaceStore.get('suture')).toBeUndefined();
    });

    it('does not overwrite a Suture workspace the owner already made', async () => {
      await workspaceStore.save({
        id: 'suture',
        name: 'Suture',
        about: 'My own words.',
        keywords: ['suture'],
        accounts: { google: 'me@trysuture.com' },
        createdAt: 1,
      });
      await productStore.seed();
      expect(await workspaceStore.get('suture')).toMatchObject({ about: 'My own words.' });
      expect((await productStore.forWorkspace('suture'))?.repo).toBe('AviOfLagos/suture');
    });
  });
});
