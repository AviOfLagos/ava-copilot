/**
 * A personality: how the assistant thinks, talks, what it pushes on and what it refuses. It is the user's own
 * setting, so its instructions are trusted, but they only shape tone and focus: the prompt builders place them
 * below the safety rules (the gate, untrusted content, workspace isolation) and say they cannot override them.
 */
export interface Personality {
  id: string;
  // 1–40 characters
  name: string;
  // One line for the picker, up to 160 characters
  description: string;
  // An emoji (or a short symbol), up to 8 characters
  icon: string;
  // How it thinks and talks, up to PERSONALITY_INSTRUCTIONS_MAX characters; empty for the default
  instructions: string;
  // Its voice on every engine, so the user hears who is talking; a missing slot keeps the voice settings
  voices: PersonalityVoices;
  // The single voice name stored before voices were per engine; read once by migrateVoices, never written
  voice?: string;
  // Speaking pace, 0.5–2; 0 keeps the voice settings
  rate: number;
  // Ships with the copilot: read-only, can be duplicated
  builtIn?: boolean;
}

/** The engines a voice can be chosen for: Gemini (Live and its read-aloud voices), the local ones, the system's. */
export const VOICE_SLOTS = ['live', 'kitten', 'kokoro', 'system'] as const;
export type VoiceSlot = (typeof VOICE_SLOTS)[number];

/**
 * A voice per engine. `live` is a Gemini prebuilt voice (Live conversations and Gemini read-aloud), `kitten` and
 * `kokoro` are those engines' voice ids, `system` is an operating-system voice name, or several separated by "|"
 * where the first one installed is used (so a built-in sounds right on macOS, Windows and ChromeOS alike).
 */
export type PersonalityVoices = Partial<Record<VoiceSlot, string>>;

export interface PersonalitiesState {
  // The user's own personalities
  custom: Personality[];
  // The personality in force outside a workspace that has its own default
  activeId: string;
  // Workspace id → the personality its chats use
  workspaceDefaults: Record<string, string>;
  // Built-in id → the voices and pace the user chose for it (built-ins are otherwise read-only)
  voiceOverrides?: Record<string, { voices: PersonalityVoices; rate: number }>;
}

export const PERSONALITY_NAME_MAX = 40;
export const PERSONALITY_DESCRIPTION_MAX = 160;
export const PERSONALITY_ICON_MAX = 8;
export const PERSONALITY_INSTRUCTIONS_MAX = 2000;
export const PERSONALITY_CUSTOM_MAX = 30;
export const PERSONALITY_RATE_MIN = 0.5;
export const PERSONALITY_RATE_MAX = 2;

export type PersonalityProblem =
  | 'nameEmpty'
  | 'nameTooLong'
  | 'descriptionTooLong'
  | 'iconTooLong'
  | 'instructionsEmpty'
  | 'instructionsTooLong'
  | 'rate'
  // Built-ins are read-only, and there is a limit to how many a user keeps
  | 'builtIn'
  | 'tooMany';
