import {
  BACKUP_CHUNK_BODY_BYTES,
  BACKUP_ROUTES,
  backupBeginRequestSchema,
  backupChunkRequestSchema,
  backupReadRequestSchema,
  backupSecretsPutRequestSchema,
} from '@protocol';
import type { z } from 'zod';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { BackupSecrets } from './secrets';
import type { BackupStore } from './store';

/** The backup API: every route needs the paired extension (auth 'api'), like the rest of /v1. */

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail('invalid', 'The backup request is not valid.');
  return parsed.data;
}

function index(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) fail('invalid', 'That part number is not valid.');
  return number;
}

export function backupRoutes(deps: { backups: BackupStore; secrets: BackupSecrets }): Route[] {
  const { backups, secrets } = deps;
  return [
    // The secrets routes come first: "secrets" is never a backup id, but DELETE /v1/backups/:id would match it
    {
      method: 'POST',
      path: BACKUP_ROUTES.secretsPut,
      name: 'backup_secrets_put',
      auth: 'api',
      rate: 'run',
      maxBodyBytes: 4_000_000,
      dedupe: true,
      async handler({ body }) {
        const request = parse(backupSecretsPutRequestSchema, body);
        return json({ ok: true, ...(await secrets.put(request.secrets)) });
      },
    },
    {
      method: 'POST',
      path: BACKUP_ROUTES.secretsGet,
      name: 'backup_secrets_get',
      auth: 'api',
      rate: 'run',
      async handler() {
        return json({ ok: true, ...(await secrets.get()) });
      },
    },
    {
      method: 'DELETE',
      path: BACKUP_ROUTES.secretsClear,
      name: 'backup_secrets_clear',
      auth: 'api',
      rate: 'run',
      async handler() {
        secrets.clear();
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: BACKUP_ROUTES.list,
      name: 'backup_list',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, snapshots: backups.list().slice(0, 200), secrets: await secrets.state() });
      },
    },
    {
      method: 'POST',
      path: BACKUP_ROUTES.begin,
      name: 'backup_begin',
      auth: 'api',
      rate: 'backup',
      dedupe: true,
      async handler({ body }) {
        const { requestId: _requestId, ...meta } = parse(backupBeginRequestSchema, body);
        return json({ ok: true, ...backups.begin(meta) });
      },
    },
    {
      method: 'PUT',
      path: BACKUP_ROUTES.chunk,
      name: 'backup_chunk',
      auth: 'api',
      rate: 'backup',
      maxBodyBytes: BACKUP_CHUNK_BODY_BYTES + 1024,
      async handler({ body, params }) {
        const { data } = parse(backupChunkRequestSchema, body);
        await backups.chunk(params.uploadId, index(params.index), Buffer.from(data, 'base64'));
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: BACKUP_ROUTES.commit,
      name: 'backup_commit',
      auth: 'api',
      rate: 'backup',
      async handler({ params }) {
        return json({ ok: true, snapshot: await backups.commit(params.uploadId) });
      },
    },
    {
      method: 'POST',
      path: BACKUP_ROUTES.read,
      name: 'backup_read',
      auth: 'api',
      rate: 'backup',
      async handler({ body, params }) {
        const request = parse(backupReadRequestSchema, body);
        const { data, chunks } = await backups.read(params.id, request.index);
        return json({ ok: true, index: request.index, chunks, data: data.toString('base64') });
      },
    },
    {
      method: 'DELETE',
      path: BACKUP_ROUTES.remove,
      name: 'backup_remove',
      auth: 'api',
      rate: 'run',
      async handler({ params }) {
        backups.remove(params.id);
        return json({ ok: true });
      },
    },
  ];
}
