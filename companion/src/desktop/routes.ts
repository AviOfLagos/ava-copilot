import {
  DESKTOP_ROUTES,
  desktopAckRequestSchema,
  desktopMessagesRequestSchema,
  desktopReplyRequestSchema,
  desktopSendRequestSchema,
} from '@protocol';
import type { z } from 'zod';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { WhatsAppService } from '../whatsapp/service';
import type { DesktopChannel } from './channel';

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail('invalid', 'The request is not valid.');
  return parsed.data;
}

/**
 * The desktop app's routes (auth 'desktop': the desktop token, no Origin) and the extension's two (auth 'api').
 */
export function desktopRoutes(deps: {
  channel: DesktopChannel;
  whatsapp: Pick<WhatsAppService, 'status'>;
  version: string;
  startedAt: number;
  now: () => number;
}): Route[] {
  const { channel } = deps;
  return [
    {
      method: 'POST',
      path: DESKTOP_ROUTES.status,
      name: 'desktop.status',
      auth: 'desktop',
      rate: 'desktop',
      async handler() {
        return json({
          ok: true,
          version: deps.version,
          uptimeMs: deps.now() - deps.startedAt,
          browserOpen: channel.browserOpen(),
          whatsapp: deps.whatsapp.status().state,
          queued: channel.queued,
          lastSeq: channel.lastSeq,
        });
      },
    },
    {
      method: 'POST',
      path: DESKTOP_ROUTES.send,
      name: 'desktop.send',
      auth: 'desktop',
      rate: 'desktop',
      dedupe: true,
      async handler({ body }) {
        const request = parse(desktopSendRequestSchema, body);
        const message = channel.send(request.chatId, request.text);
        return json({ ok: true, id: message.id, browserOpen: channel.browserOpen() });
      },
    },
    {
      method: 'POST',
      path: DESKTOP_ROUTES.messages,
      name: 'desktop.messages',
      auth: 'desktop',
      rate: 'desktop',
      async handler({ body }) {
        const { after } = parse(desktopMessagesRequestSchema, body);
        return json({
          ok: true,
          replies: channel.repliesAfter(after),
          browserOpen: channel.browserOpen(),
          lastSeq: channel.lastSeq,
        });
      },
    },
    {
      method: 'POST',
      path: DESKTOP_ROUTES.inbox,
      name: 'desktop.inbox',
      auth: 'api',
      rate: 'desktop',
      async handler() {
        return json({ ok: true, messages: channel.pending() });
      },
    },
    {
      method: 'POST',
      path: DESKTOP_ROUTES.ack,
      name: 'desktop.ack',
      auth: 'api',
      rate: 'desktop',
      async handler({ body }) {
        channel.ack(parse(desktopAckRequestSchema, body).ids);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: DESKTOP_ROUTES.reply,
      name: 'desktop.reply',
      auth: 'api',
      rate: 'desktop',
      dedupe: true,
      async handler({ body }) {
        const request = parse(desktopReplyRequestSchema, body);
        const reply = channel.reply(request.chatId, request.kind, request.text);
        return json({ ok: true, seq: reply.seq });
      },
    },
  ];
}
