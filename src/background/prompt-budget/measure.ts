/**
 * What each channel sends to a model, per prompt part (issue #130). Plain arithmetic: a part is a name and its text;
 * the estimated tokens are the characters divided by four, the same rule the research documents use, so a later
 * saving can be shown as a number and a growth caught by a test.
 */

export interface PromptPart {
  name: string;
  text: string;
}

export interface PartSize {
  name: string;
  chars: number;
  tokens: number;
}

export interface ChannelSizes {
  parts: PartSize[];
  chars: number;
  tokens: number;
}

export type Baseline = Record<string, { chars: number; parts: Record<string, number> }>;

// A channel or part may grow this much against the baseline before the test fails
export const GROWTH_LIMIT = 0.1;

export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export function sizeChannel(parts: PromptPart[]): ChannelSizes {
  const sized = parts.map(part => ({
    name: part.name,
    chars: part.text.length,
    tokens: estimateTokens(part.text.length),
  }));
  const chars = sized.reduce((sum, part) => sum + part.chars, 0);
  return { parts: sized, chars, tokens: estimateTokens(chars) };
}

export function toBaseline(channels: Record<string, ChannelSizes>): Baseline {
  return Object.fromEntries(
    Object.entries(channels).map(([name, size]) => [
      name,
      { chars: size.chars, parts: Object.fromEntries(size.parts.map(part => [part.name, part.chars])) },
    ]),
  );
}

/** Channels (and parts) that grew by more than the limit; a new channel or part is measured, not failed. */
export function growth(baseline: Baseline, now: Record<string, ChannelSizes>): string[] {
  const problems: string[] = [];
  const over = (before: number, after: number) => before > 0 && after > before * (1 + GROWTH_LIMIT);
  for (const [channel, size] of Object.entries(now)) {
    const before = baseline[channel];
    if (!before) continue;
    if (over(before.chars, size.chars)) {
      problems.push(`${channel}: ${before.chars} → ${size.chars} characters in all`);
    }
    for (const part of size.parts) {
      const was = before.parts[part.name];
      if (was !== undefined && over(was, part.chars)) {
        problems.push(`${channel} / ${part.name}: ${was} → ${part.chars} characters`);
      }
    }
  }
  return problems;
}

/** The table the test prints, and the research documents quote. */
export function formatTable(channels: Record<string, ChannelSizes>): string {
  const rows = ['| Channel | Part | Characters | Tokens (est.) |', '|---|---|---:|---:|'];
  for (const [channel, size] of Object.entries(channels)) {
    for (const part of size.parts) {
      rows.push(`| ${channel} | ${part.name} | ${part.chars} | ${part.tokens} |`);
    }
    rows.push(`| **${channel}** | **total** | **${size.chars}** | **${size.tokens}** |`);
  }
  return rows.join('\n');
}
