import { beforeEach, describe, expect, it, vi } from 'vitest';

const providers = vi.hoisted(() => ({ value: {} as Record<string, { type?: string; apiKey?: string }> }));
const profiles = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const setRole = vi.hoisted(() => vi.fn(async () => undefined));
const addInboxItem = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));
vi.mock('@extension/storage', () => ({
  ProviderTypeEnum: { Anthropic: 'anthropic' },
  llmProviderStore: { getAllProviders: async () => providers.value },
  modelSettingsStore: { setRole },
  productStore: { forWorkspace: async (id: string) => profiles.value[id] ?? null },
}));
vi.mock('../../inbox/store', () => ({ addInboxItem }));

const { checkGrowthWorkspace, GROWTH_MODELS, setGrowthModels } = await import('../setup');

beforeEach(() => {
  providers.value = {};
  profiles.value = {};
  setRole.mockClear();
  addInboxItem.mockClear();
});

describe('making a growth agent', () => {
  it('refuses a workspace with no product, and no workspace at all', async () => {
    await expect(checkGrowthWorkspace('home')).rejects.toThrow('growth_setup_needsProduct');
    await expect(checkGrowthWorkspace(null)).rejects.toThrow('growth_setup_needsProduct');
    profiles.value.suture = { id: 'suture' };
    await expect(checkGrowthWorkspace('suture')).resolves.toBeUndefined();
  });

  it('gives it Sonnet for the day and Haiku for sorting when a Claude key is set', async () => {
    providers.value = { openai: { type: 'openai', apiKey: 'x' }, claude: { type: 'anthropic', apiKey: 'k' } };
    expect(await setGrowthModels('lead')).toBe('claude');
    expect(setRole).toHaveBeenCalledWith(
      'smart',
      { providerId: 'claude', model: GROWTH_MODELS.daily },
      { agentId: 'lead' },
    );
    expect(setRole).toHaveBeenCalledWith(
      'fast',
      { providerId: 'claude', model: GROWTH_MODELS.sorting },
      { agentId: 'lead' },
    );
    expect(addInboxItem).not.toHaveBeenCalled();
  });

  it("uses the user's own roles without a Claude key, and says so once in the Inbox", async () => {
    providers.value = { anthropic: { apiKey: '' } };
    expect(await setGrowthModels('lead')).toBe('fallback');
    expect(setRole).not.toHaveBeenCalled();
    expect(addInboxItem).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'growth-models-fallback' }));
  });
});
