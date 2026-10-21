import {
  OBSIDIAN_LIMITS,
  OBSIDIAN_ROUTES,
  obsidianChooseRequestSchema,
  obsidianNotesRequestSchema,
  obsidianReadRequestSchema,
  obsidianRemoveRequestSchema,
  obsidianSearchRequestSchema,
  obsidianWriteRequestSchema,
} from '@protocol';
import type { z } from 'zod';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { ObsidianVaults } from './vault';

/** The Obsidian API: every route needs the paired extension (auth 'api'), like the rest of /v1. */

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      'invalid',
      `The vault request is not valid${issue ? ` (${issue.path.join('.') || 'body'}: ${issue.message})` : ''}.`,
    );
  }
  return parsed.data;
}

export function obsidianRoutes(deps: { vaults: ObsidianVaults }): Route[] {
  const { vaults } = deps;
  return [
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.vaults,
      name: 'obsidian.vaults',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, ...(await vaults.list()) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.choose,
      name: 'obsidian.choose',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      async handler({ body }) {
        const request = parse(obsidianChooseRequestSchema, body);
        return json({ ok: true, vault: await vaults.choose(request.path, request.expectVaultId) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.forget,
      name: 'obsidian.forget',
      auth: 'api',
      rate: 'run',
      async handler() {
        vaults.forget();
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.notes,
      name: 'obsidian.notes',
      auth: 'api',
      rate: 'vault',
      async handler({ body }) {
        const request = parse(obsidianNotesRequestSchema, body);
        return json({ ok: true, ...(await vaults.notes(request.vaultId, request)) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.read,
      name: 'obsidian.read',
      auth: 'api',
      rate: 'vault',
      async handler({ body }) {
        const request = parse(obsidianReadRequestSchema, body);
        return json({ ok: true, ...(await vaults.read(request.vaultId, request.paths)) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.write,
      name: 'obsidian.write',
      auth: 'api',
      rate: 'vault',
      dedupe: true,
      // JSON escapes can make a note's text up to six times its size
      maxBodyBytes: OBSIDIAN_LIMITS.noteBytes * 6 + 4096,
      async handler({ body }) {
        const request = parse(obsidianWriteRequestSchema, body);
        return json({ ok: true, ...(await vaults.write(request.vaultId, request)) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.remove,
      name: 'obsidian.remove',
      auth: 'api',
      rate: 'vault',
      dedupe: true,
      async handler({ body }) {
        const request = parse(obsidianRemoveRequestSchema, body);
        return json({ ok: true, removed: await vaults.remove(request.vaultId, request.path) });
      },
    },
    {
      method: 'POST',
      path: OBSIDIAN_ROUTES.search,
      name: 'obsidian.search',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        const request = parse(obsidianSearchRequestSchema, body);
        return json({ ok: true, ...(await vaults.search(request.vaultId, request.query, request.limit)) });
      },
    },
  ];
}
