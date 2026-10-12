import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { CONNECTOR_CATALOG_IDS } from '@extension/storage';
import type { ConnectorRecord } from '@extension/storage';
import { createLogger } from '../log';
import { registerCommand } from '../registry';
import { isUsableHeaderName } from './credentials';
import type { ConnectorService } from './service';

/**
 * The panel's commands for connectors. Every one answers `conn_ok` with its result, or `error` with a plain
 * sentence; secrets come in (a pasted token, a client secret) and never go back out.
 */

const logger = createLogger('Connectors');

const id = z.string().min(1).max(100);
const workspaceIds = z.array(z.string().min(1).max(100)).max(50);
const name = z.string().trim().max(60);
const secret = z.string().max(8192);
const timeoutSec = z.number().int().min(2).max(120);
const headerName = z
  .string()
  .trim()
  .max(64)
  .refine(value => value === '' || isUsableHeaderName(value), 'Not a header name that can carry a token.');
const policy = z.enum(['read', 'approve', 'off']);
const toolName = z.string().min(1).max(128);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const addSchema = z.object({
  name,
  url: z.string().trim().max(2048).optional(),
  authKind: z.enum(['none', 'token', 'oauth']).optional(),
  token: secret.optional(),
  tokenHeader: headerName.optional(),
  clientId: z.string().trim().max(512).optional(),
  clientSecret: secret.optional(),
  scope: z.string().trim().max(2000).optional(),
  workspaceIds,
  catalogId: z.enum(CONNECTOR_CATALOG_IDS).nullable().optional(),
  timeoutSec: timeoutSec.optional(),
});

export const updateSchema = z.object({
  id,
  name: name.optional(),
  url: z.string().trim().max(2048).optional(),
  workspaceIds: workspaceIds.optional(),
  enabled: z.boolean().optional(),
  token: secret.optional(),
  tokenHeader: headerName.nullable().optional(),
  clientId: z.string().trim().max(512).nullable().optional(),
  clientSecret: secret.optional(),
  scope: z.string().trim().max(2000).nullable().optional(),
  timeoutSec: timeoutSec.optional(),
});

/** What the panel may know of a connector after a change: never a secret (the record holds none). */
function view(connector: ConnectorRecord) {
  return { id: connector.id, status: connector.status, lastError: connector.lastError };
}

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'conn_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message, kind: appError.kind });
    }
  });
}

/** Reads the tools after a change, without failing the change: the panel shows why they could not be read. */
async function tryRefresh(service: ConnectorService, connectorId: string): Promise<Record<string, unknown>> {
  try {
    const summary = await service.refresh(connectorId);
    return { tools: summary.tools, added: summary.added.length, changed: summary.changed.length };
  } catch (error) {
    return { refreshError: toAppError(error).message };
  }
}

export function registerConnectorCommands(service: ConnectorService): void {
  command('conn_add', addSchema, async input => {
    const connector = await service.add({
      name: input.name,
      url: input.url,
      authKind: input.authKind,
      token: input.token,
      tokenHeader: input.tokenHeader,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      scope: input.scope,
      workspaceIds: input.workspaceIds,
      catalogId: input.catalogId ?? null,
      timeoutMs: input.timeoutSec ? input.timeoutSec * 1000 : undefined,
    });
    // A server with no sign-in, or a token already given, is read at once
    const refreshed = connector.status === 'connected' ? await tryRefresh(service, connector.id) : {};
    return { ...view(connector), ...refreshed };
  });

  command('conn_update', updateSchema, async ({ id: connectorId, timeoutSec: seconds, ...changes }) => {
    const connector = await service.update(connectorId, {
      ...changes,
      timeoutMs: seconds ? seconds * 1000 : undefined,
    });
    const reconnect =
      connector.status === 'connected' &&
      (changes.url !== undefined || changes.token !== undefined || changes.enabled === true);
    return { ...view(connector), ...(reconnect ? await tryRefresh(service, connectorId) : {}) };
  });

  command('conn_remove', z.object({ id }), async input => {
    await service.remove(input.id);
  });

  command('conn_refresh', z.object({ id }), async input => {
    const summary = await service.refresh(input.id);
    return { tools: summary.tools, added: summary.added, changed: summary.changed, removed: summary.removed };
  });

  command('conn_tool_policy', z.object({ id, tool: toolName, hash, policy }), async input => {
    await service.setToolPolicy(input.id, input.tool, input.hash, input.policy);
  });

  command(
    'conn_tools_review',
    z.object({
      id,
      policy: z.enum(['approve', 'off']),
      tools: z.array(z.object({ tool: toolName, hash })).max(500),
    }),
    async input => ({ reviewed: await service.reviewTools(input.id, input.tools, input.policy) }),
  );

  command('conn_oauth_start', z.object({ id }), input => service.beginSignIn(input.id));

  command('conn_oauth_finish', z.object({ redirectUrl: z.string().max(8192) }), async input => {
    const finished = await service.finishSignIn(input.redirectUrl);
    return {
      connectorId: finished.connectorId,
      tools: finished.summary?.tools ?? null,
      refreshError: finished.error ?? null,
    };
  });

  command('conn_sign_out', z.object({ id }), async input => {
    await service.signOut(input.id);
  });
}
