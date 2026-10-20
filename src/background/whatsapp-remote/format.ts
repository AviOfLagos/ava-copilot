import { t } from '@extension/i18n';
import type { ConfirmRequest } from '@extension/storage';

/**
 * Chat answers as WhatsApp text: its own light formatting (*bold*, bullets) instead of markdown, no tables, and a
 * length a phone screen can take. Pure, so it is tested on its own.
 */

export const WHATSAPP_REPLY_MAX = 3000;
const BOLD = '\u0001';

/** A table row as one line: its cells joined, the separator row dropped. */
function tableLine(line: string): string | null {
  const cells = line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim());
  if (cells.every(cell => /^:?-{2,}:?$/.test(cell) || cell === '')) return null;
  return cells.filter(Boolean).join(' · ');
}

/** Cuts at a paragraph, else a sentence, else a word, near the limit. */
export function clip(text: string, max: number, more = '…'): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - more.length - 1);
  const head = text.slice(0, room);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '), head.lastIndexOf('\n'));
  const end =
    cut > room * 0.6
      ? cut + (head[cut] === '.' ? 1 : 0)
      : head.lastIndexOf(' ') > room * 0.6
        ? head.lastIndexOf(' ')
        : room;
  return `${head.slice(0, end).trimEnd()} ${more}`;
}

export function toWhatsAppText(markdown: string, max = WHATSAPP_REPLY_MAX, more = '…'): string {
  const lines: string[] = [];
  let inCode = false;
  for (const raw of markdown.replaceAll(BOLD, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      lines.push(raw);
      continue;
    }
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const row = tableLine(line);
      if (row === null) continue;
      line = row;
    }
    // Bold is marked with a stand-in first, so the italics below never take it for one of theirs
    line = line
      // Headings become a bold line
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/, `${BOLD}$1${BOLD}`)
      // Bullets
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      // Images go, links keep their words and address
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, words: string, url: string) =>
        words === url ? url : `${words} (${url})`,
      )
      // Bold and italics in WhatsApp's own marks
      .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
      .replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1_$2_')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^>\s?/, '')
      .replaceAll(BOLD, '*');
    lines.push(line.trimEnd());
  }
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clip(text, max, more);
}

/** What a waiting request is about, in a few words: "send: Reply to Tomi", "the sign-in". */
export function describeRequest(request: ConfirmRequest | null | undefined): string {
  if (!request) return '';
  if (request.kind === 'questions') return t('wava_req_questions', [String(request.questions?.length ?? 0)]);
  if (request.mode === 'needs_user') {
    return request.kind === 'login'
      ? t('wava_req_login')
      : request.kind === 'captcha'
        ? t('wava_req_captcha')
        : request.kind === 'code'
          ? t('wava_req_code')
          : t('wava_req_cap');
  }
  const target = (request.target || request.intent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return target ? `${request.kind}: ${target}` : request.kind;
}
