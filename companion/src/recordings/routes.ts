import {
  RECORDING_CHUNK_BODY_BYTES,
  RECORDING_ROUTES,
  recordingBeginRequestSchema,
  recordingChunkRequestSchema,
} from '@protocol';
import type { z } from 'zod';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { RecordingFiles } from './store';

/** Saving a screen recording on the Mac: every route needs the paired extension (auth 'api'). */

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail('invalid', 'The recording request is not valid.');
  return parsed.data;
}

function index(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) fail('invalid', 'That part number is not valid.');
  return number;
}

export function recordingRoutes(deps: { recordings: RecordingFiles }): Route[] {
  const { recordings } = deps;
  return [
    {
      method: 'POST',
      path: RECORDING_ROUTES.begin,
      name: 'recording_begin',
      auth: 'api',
      rate: 'backup',
      dedupe: true,
      async handler({ body }) {
        // The request id only makes a repeat answer the same (dedupe); the store does not need it
        return json({ ok: true, ...recordings.begin(parse(recordingBeginRequestSchema, body)) });
      },
    },
    {
      method: 'PUT',
      path: RECORDING_ROUTES.chunk,
      name: 'recording_chunk',
      auth: 'api',
      rate: 'backup',
      maxBodyBytes: RECORDING_CHUNK_BODY_BYTES + 1024,
      async handler({ body, params }) {
        const { data } = parse(recordingChunkRequestSchema, body);
        await recordings.chunk(params.uploadId, index(params.index), Buffer.from(data, 'base64'));
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: RECORDING_ROUTES.commit,
      name: 'recording_commit',
      auth: 'api',
      rate: 'backup',
      async handler({ params }) {
        return json({ ok: true, path: await recordings.commit(params.uploadId) });
      },
    },
  ];
}
