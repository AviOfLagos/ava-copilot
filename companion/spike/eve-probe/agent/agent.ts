import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
// eslint-plugin-import cannot read eve's conditional exports map; the names exist (tsc checks them)
// eslint-disable-next-line import/named
import { defineAgent, defineDynamic } from 'eve';
import { profileFor } from './lib/profiles';

// (a) The model is chosen per session at runtime: any OpenAI-compatible server (Ollama, LM Studio,
// OpenRouter, NVIDIA). Only step.started may return a live LanguageModel; the context window is given so
// eve never asks the AI Gateway catalog for it.
export default defineAgent({
  // Only the profile's tools: no host web_fetch, no eve sandbox bash (Avi Brain's own sandbox runs code)
  defaultTools: false,
  model: defineDynamic({
    events: {
      'step.started': (_event, ctx) => {
        const profile = profileFor(ctx.session.auth.initiator?.attributes?.profileId);
        const provider = createOpenAICompatible({
          name: 'probe-local',
          baseURL: process.env.PROBE_LLM_URL ?? 'http://127.0.0.1:1/v1',
          apiKey: process.env.PROBE_LLM_KEY,
        });
        return { model: provider.chatModel(profile.model), modelContextWindowTokens: 32_000 };
      },
    },
  }),
});
