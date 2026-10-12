import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentProfileSchema } from '@protocol';
import type { AgentProfile, ModelConfig } from '@protocol';
import type { KeyStore } from '../workflows/keys';

/**
 * The agent profiles sessions run as, and their models. A profile (instructions, tools, sandbox limits)
 * is kept on disk so a session waiting for an approval survives a restart; a model's key only in memory
 * (KeyStore), so after a restart the extension sends it again with its next request.
 */
export class ProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly models = new Map<string, Omit<ModelConfig, 'apiKey'>>();
  private readonly sessions = new Map<string, string>();
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly keys: KeyStore,
  ) {
    this.path = join(dataDir, 'profiles.json');
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as {
        profiles?: unknown[];
        models?: Record<string, Omit<ModelConfig, 'apiKey'>>;
        sessions?: Record<string, string>;
      };
      for (const raw of saved.profiles ?? []) {
        const parsed = agentProfileSchema.safeParse(raw);
        if (parsed.success) this.profiles.set(parsed.data.id, parsed.data);
      }
      for (const [id, model] of Object.entries(saved.models ?? {})) this.models.set(id, model);
      for (const [session, profile] of Object.entries(saved.sessions ?? {})) this.sessions.set(session, profile);
    } catch {
      // First start
    }
  }

  private async save(): Promise<void> {
    const temporary = `${this.path}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        profiles: [...this.profiles.values()],
        models: Object.fromEntries(this.models),
        sessions: Object.fromEntries([...this.sessions].slice(-500)),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, this.path);
  }

  async put(profile: AgentProfile, model: ModelConfig): Promise<void> {
    this.profiles.set(profile.id, profile);
    this.models.set(profile.id, {
      provider: model.provider,
      baseUrl: model.baseUrl,
      model: model.model,
      contextWindow: model.contextWindow,
    });
    if (model.apiKey) await this.keys.set(`profile:${profile.id}`, model.apiKey, false);
    else await this.keys.delete(`profile:${profile.id}`);
    await this.save();
  }

  profile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  async model(id: string): Promise<(Omit<ModelConfig, 'apiKey'> & { apiKey?: string }) | undefined> {
    const model = this.models.get(id);
    if (!model) return undefined;
    const apiKey = (await this.keys.get(`profile:${id}`)) ?? undefined;
    return { ...model, apiKey };
  }

  async bind(sessionId: string, profileId: string): Promise<void> {
    this.sessions.set(sessionId, profileId);
    await this.save();
  }

  profileOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }
}
