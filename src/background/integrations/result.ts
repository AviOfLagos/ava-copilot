/**
 * A tool's answer as text for the agent or a routine: text parts as they are, structured content as compact JSON
 * when there is no text, and files, images and sounds named but not inlined. Cut to a size, and saying so.
 */

export interface FormattedResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

interface ContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

function approxBytes(base64: string | undefined): number {
  return base64 ? Math.floor((base64.length * 3) / 4) : 0;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? '';
    case 'image':
      return `[image ${block.mimeType ?? ''}, ${approxBytes(block.data)} bytes, not shown]`;
    case 'audio':
      return `[audio ${block.mimeType ?? ''}, ${approxBytes(block.data)} bytes, not played]`;
    case 'resource_link':
      return `[link] ${block.name ?? ''} ${block.uri ?? ''}`.trim();
    case 'resource': {
      const resource = block.resource ?? {};
      if (typeof resource.text === 'string') return `[${resource.uri ?? 'resource'}]\n${resource.text}`;
      return `[file ${resource.uri ?? ''} ${resource.mimeType ?? ''}, ${approxBytes(resource.blob)} bytes, not shown]`;
    }
    default:
      return '';
  }
}

export function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: `${text.slice(0, max)}\n[…cut at ${max} characters]`, truncated: true }
    : { text, truncated: false };
}

/** Formats an MCP CallToolResult. `maxChars` caps the text. */
export function formatToolResult(result: unknown, maxChars: number): FormattedResult {
  const value = (result ?? {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
    toolResult?: unknown;
  };
  const blocks = Array.isArray(value.content) ? (value.content as ContentBlock[]) : [];
  let text = blocks
    .map(blockText)
    .filter(part => part.trim())
    .join('\n\n');
  if (!text && value.structuredContent !== undefined) {
    try {
      text = JSON.stringify(value.structuredContent);
    } catch {
      text = '';
    }
  }
  // Servers on the oldest protocol answer with toolResult instead of content
  if (!text && value.toolResult !== undefined) {
    try {
      text = typeof value.toolResult === 'string' ? value.toolResult : JSON.stringify(value.toolResult);
    } catch {
      text = '';
    }
  }
  const shown = cut(text || '(no content)', maxChars);
  return { text: shown.text, truncated: shown.truncated, isError: value.isError === true };
}
