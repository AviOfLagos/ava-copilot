import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
// eslint-plugin-import cannot read eve's conditional exports map; the names exist (tsc checks them)
// eslint-disable-next-line import/named
import { defineAgent, defineDynamic } from 'eve';
import { loadModel, profileIdOf } from './lib/avi-brain';

/**
 * Avi Brain's one generic worker agent. Each session runs as one of the user's agent profiles: Avi Brain
 * puts the profile id on the session, and the model, instructions and tools come from it.
 */
export default defineAgent({
  // Only the profile's tools: no eve sandbox shell, no host-side web_fetch
  defaultTools: false,
  model: defineDynamic({
    events: {
      // Only step.started may return a live model (any OpenAI-compatible endpoint); the context window is
      // given so eve never asks the AI Gateway catalog. The key is fetched, never stored in the session.
      'step.started': async (_event, ctx) => {
        const model = await loadModel(profileIdOf(ctx));
        const provider = createOpenAICompatible({ name: model.provider, baseURL: model.baseUrl, apiKey: model.apiKey });
        return { model: provider.chatModel(model.model), modelContextWindowTokens: model.contextWindow };
      },
    },
  }),
});
