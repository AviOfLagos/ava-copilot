// Emoji and pictographs: not CJK, which the model may answer in, so the ranges stay well clear of it.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// The emoji variation selector, kept out of the class above since a lone modifier inside one reads as
// a mistake to the linter
const VARIATION_SELECTOR = /\u{FE0F}/gu;

/**
 * Markdown from the model, as words to say: headings and emphasis lose their marks, list bullets and
 * numbers are dropped (the words still read fine without them), code is skipped rather than spelled
 * out, a link keeps its words and drops its address, and emoji are removed. Not a full parser - just
 * enough to stop a voice reading out "asterisk asterisk" or a URL.
 */
export function toSpeakableText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: reading source code aloud helps no one
  text = text.replace(/```[\s\S]*?```/g, '\n');
  // Images: alt text rarely stands on its own; drop before the link rule below can catch its brackets
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');
  // Links: the label is the words worth saying
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline code: keep the text, drop the backticks
  text = text.replace(/`([^`]*)`/g, '$1');
  // Headings
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Bold / italic / strikethrough marks, longest first so "***x***" does not leave stray marks behind
  text = text.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(?<![a-zA-Z0-9])(\*|_)(.+?)\1(?![a-zA-Z0-9])/g, '$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  // Blockquotes
  text = text.replace(/^>\s?/gm, '');
  // Horizontal rules
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  // List bullets and ordered numbers
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  // Tables: a pipe becomes a pause rather than being read as "pipe"; separator rows are dropped
  text = text.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '');
  text = text.replace(/\|/g, ', ');
  // Emoji and pictographs
  text = text.replace(EMOJI, '').replace(VARIATION_SELECTOR, '');

  // Collapse what all that leaves behind
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text.trim();
}
