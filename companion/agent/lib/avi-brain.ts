/**
 * How the eve agent reaches Avi Brain: its internal API on 127.0.0.1, with the per-boot secret Avi Brain
 * gave this process. Profiles, models (with their keys) and every tool call go through here, so nothing
 * secret is ever part of a session, a tool closure or eve's durable store.
 */

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface AviProfile {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
  mcpTools: string[];
  sandbox: { network: 'none' | 'open'; timeoutSec: number };
}

export interface AviModel {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow: number;
}

function internal(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const base = process.env.AVI_BRAIN_INTERNAL_URL;
  const secret = process.env.AVI_BRAIN_INTERNAL_SECRET;
  if (!base || !secret) throw new Error('Avi Brain did not start this agent.');
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The profile id Avi Brain put on the session when it created it. */
export function profileIdOf(ctx: {
  session: { auth: { initiator?: { attributes?: Record<string, unknown> } | null } };
}): string {
  const id = ctx.session.auth.initiator?.attributes?.profileId;
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('This session has no agent profile.');
  return id;
}

export async function loadProfile(profileId: string): Promise<AviProfile> {
  const response = await internal(`/profiles/${profileId}`);
  const reply = (await response.json()) as { ok?: boolean; profile?: AviProfile };
  if (!response.ok || !reply.profile) throw new Error('Avi Brain does not know this agent profile.');
  return reply.profile;
}

const modelCache = new Map<string, { at: number; model: AviModel }>();

/** The profile's model and key, asked again at most every 30 s. Kept in memory only. */
export async function loadModel(profileId: string): Promise<AviModel> {
  const cached = modelCache.get(profileId);
  if (cached && Date.now() - cached.at < 30_000) return cached.model;
  const response = await internal(`/models/${profileId}`);
  const reply = (await response.json()) as { ok?: boolean; model?: AviModel };
  if (!response.ok || !reply.model) throw new Error('Avi Brain has no model for this agent profile.');
  modelCache.set(profileId, { at: Date.now(), model: reply.model });
  return reply.model;
}

/** Runs one of Avi Brain's tools for this session's profile; its rules are checked there. */
/**
 * Runs one of the session's tools in Avi Brain. `approved` only from a tool eve holds for the user's click
 * (approval: always()), so Avi Brain can check the click happened; the model never sets it.
 */
export async function callAviBrain(
  name: string,
  input: unknown,
  ctx: Parameters<typeof profileIdOf>[0],
  { approved = false }: { approved?: boolean } = {},
): Promise<unknown> {
  const profileId = profileIdOf(ctx);
  // A sandbox command may run up to an hour; everything else is quick
  const timeoutMs = name === 'run_command' || name === 'publish_artifact' ? 65 * 60_000 : 120_000;
  const response = await internal(
    `/tools/${name}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId, input, approved }),
    },
    timeoutMs,
  );
  const reply = (await response.json()) as { ok?: boolean; output?: unknown; error?: { message?: string } };
  if (!response.ok || !reply.ok) return { error: reply.error?.message ?? `${name} failed.` };
  return reply.output;
}
