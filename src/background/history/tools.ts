/** The AI tools whose local history can be brought in, by the id kept on each imported item. */
export const AI_TOOLS = ['claude-code', 'codex', 'gemini-cli', 'vscode', 'chatgpt', 'claude-ai'] as const;
export type AiTool = (typeof AI_TOOLS)[number];

const NAMES: Record<AiTool, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  vscode: 'VS Code Copilot',
  chatgpt: 'ChatGPT',
  'claude-ai': 'Claude.ai',
};

/** A tool's name as people know it; an unknown id comes back as it is. */
export function aiToolName(tool: string): string {
  return NAMES[tool as AiTool] ?? tool;
}

export interface ImportedTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number | null;
}

/** One conversation from another AI tool, as read from its files: only what the user and the AI said. */
export interface ImportedConversation {
  // Stable within its tool: a session id, or a conversation id from an export
  id: string;
  tool: AiTool;
  title: string;
  // The folder the session ran in (Claude Code, Codex, Gemini CLI, VS Code), or null
  project: string | null;
  branch: string | null;
  startedAt: number;
  updatedAt: number;
  turns: ImportedTurn[];
}
