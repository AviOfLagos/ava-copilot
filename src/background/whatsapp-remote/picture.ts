import { z } from 'zod';
import { llmProviderStore, threadStore } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { WHATSAPP_CAPTION_MAX } from '@src/shared/lib/protocol/companion';
import type { WhatsAppSendMediaRequest } from '@src/shared/lib/protocol/companion';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { companionClient } from '../companion/client';
import { imageModelFor, makePicture, pictureCostUsd } from '../llm/images';
import type { MadePicture } from '../llm/images';
import { resolveRole } from '../models/roles';
import { whatsappRemoteStateStore } from './state';

/**
 * `send_whatsapp_picture` (#204): a picture to the owner, from a WhatsApp chat only. Either a screenshot of the page
 * the chat is on, or one made from a description with the "image" model. A made picture that costs money is not
 * made until he has been told the price in the chat and said yes (`cost_ok`).
 */

export const sendPictureActionSchema = {
  name: 'send_whatsapp_picture',
  description:
    'In a WhatsApp chat only: send the owner a picture on WhatsApp. source "screenshot" sends the page you are on as it looks now; source "generate" makes a new picture from `description` with the picture model set in Models & usage. Making one usually costs money: the first call only says the price. Tell him the price and call again with cost_ok true only after he says yes in this chat. The picture goes to him at once; then answer in one short line, without describing the picture again.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    source: z
      .enum(['screenshot', 'generate'])
      .describe('"screenshot" of the current page, or "generate" a new picture'),
    description: z
      .string()
      .max(2000)
      .default('')
      .describe('for "generate": what the picture shows, in detail (subject, setting, light, style)'),
    caption: z.string().max(WHATSAPP_CAPTION_MAX).default('').describe('words under the picture; may be empty'),
    cost_ok: z.boolean().default(false).describe('true only once he said yes to the price in this chat'),
  }),
} satisfies ActionSchema;

export const PICTURE_PROMPT = `- send_whatsapp_picture: only in a WhatsApp chat, when he asks for a picture or a screenshot. A made picture costs money: say the price it gives and wait for his yes before calling it with cost_ok true.`;

export interface PictureDeps {
  origin: (threadId: string) => Promise<string | null>;
  replyTo: (threadId: string) => Promise<string | null>;
  screenshot: (context: AgentContext) => Promise<string | null>;
  // The picture model: what it costs (null: unknown), and how to make one; null when none is set up
  imageModel: (context: AgentContext) => Promise<{
    label: string;
    costUsd: number | null;
    local: boolean;
    make: (prompt: string) => Promise<MadePicture>;
  } | null>;
  send: (request: Omit<WhatsAppSendMediaRequest, 'requestId'>) => Promise<void>;
}

function fail(context: AgentContext, error: string): ActionResult {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
  return new ActionResult({ error, includeInMemory: true });
}

/** "$0.04", "$0.011" */
export function priceText(usd: number | null): string {
  if (usd === null) return 'an amount the provider does not list here';
  return `about $${usd < 0.1 ? usd.toFixed(usd < 0.02 ? 3 : 2) : usd.toFixed(2)}`;
}

export async function sendPictureAction(
  context: AgentContext,
  input: z.infer<typeof sendPictureActionSchema.schema>,
  deps: PictureDeps = defaultPictureDeps,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Sending a picture on WhatsApp');
  if ((await deps.origin(context.taskId)) !== 'whatsapp') {
    return fail(context, 'send_whatsapp_picture only works in a WhatsApp chat. Here, show or describe it instead.');
  }
  let picture: MadePicture;
  if (input.source === 'screenshot') {
    const shot = await deps.screenshot(context).catch(() => null);
    if (!shot) return fail(context, 'No page to take a screenshot of. Open the page first.');
    picture = { base64: shot, mediaType: 'image/jpeg' };
  } else {
    const description = input.description.trim();
    if (!description) return fail(context, 'Say what the picture should show in `description`.');
    const model = await deps.imageModel(context).catch(() => null);
    if (!model) {
      return fail(
        context,
        'No picture model is set up. Tell him to add one in Models & usage → Pictures (for example OpenAI gpt-image-1), and that nothing was made.',
      );
    }
    if (!model.local && !input.cost_ok) {
      const price = priceText(model.costUsd);
      return new ActionResult({
        extractedContent: `Not made yet. One picture with ${model.label} costs ${price}. Ask him in one line whether to make it for that; call again with cost_ok true only after he says yes.`,
        includeInMemory: true,
      });
    }
    try {
      picture = await model.make(description);
    } catch (error) {
      return fail(context, `The picture could not be made: ${toAppError(error).message}`);
    }
  }
  try {
    const replyTo = await deps.replyTo(context.taskId);
    await deps.send({
      media: 'image',
      data: picture.base64,
      mimetype: picture.mediaType,
      ...(input.caption.trim() ? { caption: input.caption.trim() } : {}),
      kind: 'reply',
      ...(replyTo ? { replyTo } : {}),
    });
  } catch (error) {
    return fail(context, `The picture could not be sent on WhatsApp: ${toAppError(error).message}`);
  }
  const done = input.source === 'screenshot' ? 'Screenshot sent on WhatsApp.' : 'Picture sent on WhatsApp.';
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, done);
  return new ActionResult({ extractedContent: done, includeInMemory: true });
}

const defaultPictureDeps: PictureDeps = {
  origin: async threadId => (await threadStore.get(threadId))?.origin ?? null,
  replyTo: async threadId => {
    const state = await whatsappRemoteStateStore.getState();
    return state.threadId === threadId ? state.replyTo : null;
  },
  screenshot: async context => (await context.browserContext.getCurrentPage()).takeScreenshot(),
  imageModel: async context => {
    const thread = await threadStore.get(context.taskId);
    const choice = await resolveRole('image', { workspaceId: thread?.workspaceId ?? null });
    const provider = await llmProviderStore.getProvider(choice.providerId);
    const model = provider ? imageModelFor(provider, choice.providerId, choice.model) : null;
    if (!model) return null;
    return {
      label: choice.model,
      costUsd: pictureCostUsd(choice.model),
      local: choice.local,
      make: prompt => makePicture(model, prompt, context.controller.signal),
    };
  },
  send: async request => {
    await companionClient.whatsappSendMedia({ requestId: crypto.randomUUID(), ...request });
  },
};
