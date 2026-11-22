// Product profiles: the one-time seed of the owner's own product (owner build only), and Ava's confirmed way
// to change a profile. The profile reaches agents through the workspace section (../workspaces/inject.ts).
import type { z } from 'zod';
import { productStore } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import { createLogger } from '../log';
import { registerAgentAction, registerRecovery } from '../registry';
import { UPDATE_PRODUCT_PROFILE_PROMPT, updateProductProfileAction, updateProductProfileActionSchema } from './action';

const logger = createLogger('Products');

// At startup, so the workspace is in the picker before anything asks for its product
registerRecovery('products', async () => {
  await productStore.seed().catch(error => logger.warning('Could not seed the product profile', error));
});

registerAgentAction({
  prompt: UPDATE_PRODUCT_PROFILE_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof updateProductProfileActionSchema.schema>) => updateProductProfileAction(context, input),
      updateProductProfileActionSchema,
    ),
});
