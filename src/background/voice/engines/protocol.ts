import { z } from 'zod';

/**
 * Messages between the economy conversation in the offscreen document and the background, which holds the text
 * model, the tools and the system voices. The offscreen document hears and speaks; the background thinks. Every
 * message is checked here before it is used.
 */

const declaration = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(2000),
  parameters: z
    .object({
      type: z.literal('OBJECT'),
      properties: z.record(z.string(), z.object({ type: z.string(), description: z.string().optional() })),
      required: z.array(z.string()).optional(),
    })
    .optional(),
});

export const economyHistoryItem = z.object({
  heard: z.string().max(4000),
  said: z.string().max(4000),
  // `heard` was a notice from the browser, not the user's words
  notice: z.boolean().optional(),
});

/** One turn: what the user said (or a notice to pass on), with the conversation so far. */
export const economyTurnRequest = z
  .object({
    type: z.literal('voice_engine_turn'),
    heard: z.string().max(4000).optional(),
    notice: z.string().max(4000).optional(),
    // `heard` was typed in the conversation's chat, with these pictures (a video as its frames)
    typed: z.boolean().optional(),
    images: z
      .array(z.object({ mediaType: z.string().max(40), data: z.string().max(14_000_000) }))
      .max(40)
      .optional(),
    note: z.string().max(20_000).optional(),
    history: z.array(economyHistoryItem).max(40),
    instructions: z.string().max(60_000),
    tools: z.array(declaration).max(80),
  })
  .refine(turn => Boolean(turn.heard?.trim() || turn.notice?.trim()), 'A turn needs words or a notice');

export type EconomyTurnRequest = z.infer<typeof economyTurnRequest>;
export type EconomyHistoryItem = z.infer<typeof economyHistoryItem>;

export interface EconomyTurnReply {
  said: string;
  // end_conversation was called: nothing more is said
  ended?: boolean;
  // Why the turn failed, in a plain sentence
  error?: string;
}

/** System voices speak from the background (an offscreen document has no chrome.tts). */
export const systemSayRequest = z.object({
  type: z.literal('voice_engine_system_say'),
  text: z.string().max(20_000),
  rate: z.number().min(0.5).max(2).optional(),
  voice: z.string().max(200).optional(),
});
