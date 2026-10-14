import type { DraftChunk } from '../kb/chunker';
import { CHUNK_CHARS, splitText } from '../kb/chunker';
import { aiToolName } from './tools';
import type { ImportedConversation } from './tools';

function day(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The line that says where a session comes from, at the head of its first passage. */
export function sessionHeader(conversation: Pick<ImportedConversation, 'tool' | 'project' | 'branch' | 'startedAt'>) {
  return [
    `${aiToolName(conversation.tool)} session`,
    conversation.project && `in ${conversation.project}`,
    conversation.branch && `(branch ${conversation.branch})`,
    `on ${day(conversation.startedAt)}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * An imported conversation as passages of about one chunk each: "User: …" and "Assistant: …" turns
 * kept whole where they fit, each passage citing the session and the turn it starts at.
 */
export function chunkSession(itemId: string, conversation: ImportedConversation): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  let lines: string[] = [sessionHeader(conversation)];
  let startTurn = 1;
  const flush = (nextTurn: number) => {
    const text = lines.join('\n\n').trim();
    if (text) chunks.push({ text, label: `turn ${startTurn}`, anchor: { kind: 'note', itemId } });
    lines = [];
    startTurn = nextTurn;
  };
  conversation.turns.forEach((turn, index) => {
    const line = `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`;
    const size = lines.join('\n\n').length;
    if (size + line.length + 2 > CHUNK_CHARS && lines.length > 0) flush(index + 1);
    if (line.length > CHUNK_CHARS) {
      for (const piece of splitText(line, CHUNK_CHARS)) {
        lines.push(piece);
        flush(index + 1);
      }
      return;
    }
    lines.push(line);
  });
  flush(conversation.turns.length);
  return chunks;
}
