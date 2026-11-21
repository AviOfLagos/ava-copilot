// Agent name, used to identify the agent in the settings
export enum AgentNameEnum {
  Planner = 'planner',
  Navigator = 'navigator',
}

// Provider type, types before CustomOpenAI are built-in providers, CustomOpenAI is a custom provider
// For built-in providers, we will create ChatModel instances with its respective LangChain ChatModel classes
// For custom providers, we will create ChatModel instances with the ChatOpenAI class.
// NVIDIA NIM and LM Studio are OpenAI-compatible endpoints with a known address: they run through the
// custom OpenAI path in createChatModel, and are named here so they can be picked and discovered.
export enum ProviderTypeEnum {
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  DeepSeek = 'deepseek',
  Gemini = 'gemini',
  Grok = 'grok',
  Ollama = 'ollama',
  AzureOpenAI = 'azure_openai',
  OpenRouter = 'openrouter',
  Nvidia = 'nvidia',
  LMStudio = 'lmstudio',
  CustomOpenAI = 'custom_openai',
}

/**
 * Suggested models for each built-in provider, shown before the model registry has listed what the
 * provider really offers. Once the catalog has a provider's models, the catalog is the source of truth.
 */
export const llmProviderModelNames = {
  [ProviderTypeEnum.OpenAI]: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
  [ProviderTypeEnum.Anthropic]: [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-haiku-4-5',
  ],
  [ProviderTypeEnum.DeepSeek]: ['deepseek-flash', 'deepseek-v4-pro'],
  [ProviderTypeEnum.Gemini]: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite'],
  [ProviderTypeEnum.Grok]: ['grok-4.7'],
  [ProviderTypeEnum.Ollama]: ['qwen3.8', 'qwen3.8:27b-mlx'],
  [ProviderTypeEnum.AzureOpenAI]: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
  [ProviderTypeEnum.OpenRouter]: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'openai/gpt-4o-2024-11-20'],
  [ProviderTypeEnum.Nvidia]: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'],
  // LM Studio serves whatever is loaded in it; the registry lists it
  [ProviderTypeEnum.LMStudio]: [] as string[],
  // Custom OpenAI providers don't have predefined models as they are user-defined
};
