import type {
  FlexibleSchema,
  JSONSchema7,
  LanguageModel,
  ModelMessage,
  generateText,
  SystemModelMessage,
  UserModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
} from 'ai';

/** Provider-specific options keyed by provider name, as accepted by `generateText` */
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

/**
 * How structured output is requested from a model.
 * - `native`: `Output.object`, mapped by the provider to its JSON-schema response format; switches to `tool`
 *   when the server rejects response formats ("structured output is unavailable")
 * - `tool`: a single forced tool call whose input is the output; models that reject forced tool use
 *   (newer Claude models) get the tool with automatic choice plus a prompt instruction instead
 * - `text`: plain text generation followed by manual JSON extraction
 */
export type StructuredMode = 'native' | 'tool' | 'text';

/** Call settings. Temperature and top P are never sent, so sampling is left to each model's defaults */
export interface ChatModelSettings {
  maxOutputTokens?: number;
  /** The AI SDK's provider-independent reasoning effort; unset leaves the model's default reasoning */
  reasoning?: Parameters<typeof generateText>[0]['reasoning'];
}

/**
 * A configured model plus everything needed to call it.
 * Built by `createChatModel` and consumed by `generateStructured` / `generatePlainText`.
 */
export interface ChatModel {
  /** Provider id, e.g. 'openai' or a custom id such as 'azure_openai_2' */
  provider: string;
  /** Model name as configured (the deployment name for Azure) */
  modelName: string;
  model: LanguageModel;
  settings: ChatModelSettings;
  providerOptions?: ProviderOptions;
  structuredMode: StructuredMode;
  /** In text mode, request the provider's JSON mode (DeepSeek JSON Output); the output is still validated locally */
  jsonOutput?: boolean;
  /** In tool mode, offer the tool with automatic choice: Claude rejects a forced tool choice while thinking */
  autoToolChoice?: boolean;
  /** For a cloud model: the local model a failed call is tried again on (see `callWithFallback`) */
  fallback?: ModelFallback;
}

/** Why a cloud call was given to a local model; the kinds of `AppError` that allow it. */
export type FallbackReason = 'auth' | 'forbidden' | 'quota' | 'rate_limit' | 'unavailable' | 'network' | 'timeout';

/**
 * How a cloud model hands a failed call to a local one. After the first switch the local model answers every later
 * call of the same chat model, so a task does not wait out the cloud's retries again on each step.
 */
export interface ModelFallback {
  /** The metered local model, or null when there is none or its server does not answer */
  resolve: () => Promise<ChatModel | null>;
  /** Called once, after the local model's first answer: the note in the chat */
  onSwitch: (to: ChatModel, reason: FallbackReason) => void;
  /** Set after the first switch */
  active?: ChatModel;
}

export type {
  FlexibleSchema,
  JSONSchema7,
  ModelMessage,
  SystemModelMessage,
  UserModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
};
