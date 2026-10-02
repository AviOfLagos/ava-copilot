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
