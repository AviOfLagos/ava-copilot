import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { registerCommand } from '../registry';
import { SETUP_TARGETS } from './setup';
import type { ConnectionSetup } from './setup';

/** The panel's "Set it up with Ava" button: the next step of a setup, as `conn_setup_step`. */
export const setupSchema = z.object({
  target: z.enum(SETUP_TARGETS),
  url: z.string().trim().max(2048).optional(),
  name: z.string().trim().max(60).optional(),
  provider: z.string().trim().max(40).optional(),
  workspaceId: z.string().min(1).max(100).nullable().optional(),
  open: z.boolean().optional(),
});

export function registerSetupCommand(setup: ConnectionSetup): void {
  registerCommand('conn_setup', setupSchema, async (input, context) => {
    try {
      const step = await setup.advance(input);
      context.reply({ type: 'conn_setup_step', requestId: context.requestId, ...step });
    } catch (error) {
      const appError = toAppError(error);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message, kind: appError.kind });
    }
  });
}
