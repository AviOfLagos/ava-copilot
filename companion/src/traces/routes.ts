import { TRACE_MAX_BODY_BYTES, TRACES_ROUTES, traceKeepRequestSchema } from '@protocol';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { TraceStore } from './store';

/** Keeps the paired extension's traces on the Mac (auth 'api'). */
export function traceRoutes(deps: { traces: TraceStore }): Route[] {
  return [
    {
      method: 'POST',
      path: TRACES_ROUTES.keep,
      name: 'traces.keep',
      auth: 'api',
      rate: 'read',
      maxBodyBytes: TRACE_MAX_BODY_BYTES,
      async handler({ body }) {
        const parsed = traceKeepRequestSchema.safeParse(body);
        if (!parsed.success) fail('invalid', 'The trace is not an OTLP/JSON request.');
        await deps.traces.keep(parsed.data.trace);
        return json({ ok: true });
      },
    },
  ];
}
