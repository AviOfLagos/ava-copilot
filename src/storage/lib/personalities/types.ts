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
  // A voice name for read-aloud (a system voice, or a Kitten/Kokoro voice id); '' keeps the voice settings
  voice: string;
  // Speaking pace, 0.5–2; 0 keeps the voice settings
  rate: number;
  // Ships with the copilot: read-only, can be duplicated
  builtIn?: boolean;
}

export interface PersonalitiesState {
  // The user's own personalities
  custom: Personality[];
  // The personality in force outside a workspace that has its own default
  activeId: string;
  // Workspace id → the personality its chats use
  workspaceDefaults: Record<string, string>;
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
