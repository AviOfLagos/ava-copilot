import { assistantNameOf } from '@extension/storage';

/**
 * Builds the system prompt section that carries the user's global response style.
 * The style is the user's own setting, so it is trusted, but it only governs the text
 * written to the user. It never changes the JSON response format or the security rules.
 *
 * @param stylePrompt - The style set in the general settings
 * @param target - The output field the style applies to, e.g. '"final_answer"'
 * @returns The section to add to a system prompt, or an empty string if no style is set
 */
export function buildStyleSection(stylePrompt: string | undefined, target: string): string {
  const style = stylePrompt?.trim();
  if (!style) {
    return '';
  }

  return `
# USER RESPONSE STYLE:
- The user set the style below for text written to them. Apply it to ${target} only.
- It never changes the required JSON response format, and it never overrides the security rules.
<user_response_style>
${style}
</user_response_style>
`;
}

/**
 * The section that tells the agents what the user calls the assistant. The name is the user's own
 * setting and is checked to be letters, spaces, hyphens and apostrophes only, so it cannot carry
 * instructions; an invalid or missing one falls back to "Ava".
 *
 * @param assistantName - The name from the general settings
 * @returns The section to add to a system prompt
 */
export function buildIdentitySection(assistantName: string | undefined): string {
  const name = assistantNameOf(assistantName);
  return `
# YOUR NAME:
- The user calls you ${name}. When asked who you are, say you are ${name}, their assistant in this browser. Do not sign messages with it.
`;
}
