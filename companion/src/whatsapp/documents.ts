import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { WHATSAPP_DOCUMENT_TEXT_MAX } from '@protocol';
import { hostToolEnv } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';

/**
 * The text of a document the owner sent on WhatsApp, read on the Mac with what macOS ships: PDFKit for a PDF,
 * textutil for Word, RTF, OpenDocument and web pages, unzip for Excel and PowerPoint, and plain reading for text
 * files. No document is ever run or opened in an app; each tool gets the file's path as an argument (no shell)
 * and has a time limit and an output cap. What comes back is the document's words, to keep and to read, never
 * instructions.
 */

const TIMEOUT_MS = 30_000;
// The most output a tool may print; the text is cut to WHATSAPP_DOCUMENT_TEXT_MAX after
const OUTPUT_MAX = 4_000_000;

const PLAIN = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.ics']);
const TEXTUTIL = new Set(['.docx', '.doc', '.rtf', '.rtfd', '.odt', '.html', '.htm', '.wordml', '.webarchive']);
const PLAIN_TYPES = /^text\/|^application\/(json|xml|x-yaml|csv)/;

// Reads a PDF's text with PDFKit; the path comes in as an argument, never as part of the script
const PDF_SCRIPT =
  'function run(argv){ObjC.import("PDFKit");const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));if(d.isNil())return "";return ObjC.unwrap(d.string)||"";}';

export interface DocumentText {
  // Null when this kind of file cannot be read
  text: string | null;
  truncated: boolean;
}

/** The kind of reading a file needs, from its name, else its type. */
export function readerFor(name: string | null, mediaType: string | null): string | null {
  const extension = extname(name ?? '').toLowerCase();
  const type = (mediaType ?? '').split(';')[0].trim().toLowerCase();
  if (extension === '.pdf' || type === 'application/pdf') return 'pdf';
  if (extension === '.xlsx' || type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return 'xlsx';
  if (extension === '.pptx' || type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    return 'pptx';
  if (TEXTUTIL.has(extension) || type === 'application/msword' || type.includes('wordprocessingml')) return 'textutil';
  if (PLAIN.has(extension) || PLAIN_TYPES.test(type)) return 'plain';
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text: string) =>
  text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });

/** The words in the <t> elements of an Office XML part (shared strings, a slide), one run after another. */
function runsOf(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of xml.matchAll(pattern)) out.push(unescapeXml(match[1]));
  return out;
}

/** A sheet as rows of tab-separated cells, with shared strings filled in. */
export function sheetText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
      const inner = cell[2] ?? '';
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (type === 's' && value !== undefined) cells.push(shared[Number(value)] ?? '');
      else if (type === 'inlineStr') cells.push(runsOf(inner, 't').join(''));
      else cells.push(value !== undefined ? unescapeXml(value) : '');
    }
    if (cells.some(cell => cell.trim())) rows.push(cells.join('\t').trimEnd());
  }
  return rows.join('\n');
}

// "xl/worksheets/sheet10.xml" after "sheet2.xml"
const byNumber = (a: string, b: string) =>
  Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

export interface DocumentDeps {
  run: ProcessRunner;
}

/** Reads a document's text, cut to WHATSAPP_DOCUMENT_TEXT_MAX characters. */
export async function documentText(
  path: string,
  name: string | null,
  mediaType: string | null,
  deps: DocumentDeps,
): Promise<DocumentText> {
  const reader = readerFor(name, mediaType);
  if (!reader) return { text: null, truncated: false };
  const env = hostToolEnv();
  const tool = async (command: string, args: string[]) => {
    const result = await deps.run(command, args, { env, timeoutMs: TIMEOUT_MS, maxOutputBytes: OUTPUT_MAX });
    if (result.code !== 0 || result.timedOut) throw new Error('The document could not be read.');
    return result.stdout;
  };
  const unzip = (part: string) => tool('/usr/bin/unzip', ['-p', '--', path, part]);
  let text: string;
  if (reader === 'plain') {
    text = (await readFile(path)).subarray(0, OUTPUT_MAX).toString('utf8');
  } else if (reader === 'pdf') {
    text = await tool('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, path]);
  } else if (reader === 'textutil') {
    text = await tool('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '--', path]);
  } else {
    const parts = (await tool('/usr/bin/unzip', ['-Z1', '--', path])).split('\n').map(line => line.trim());
    if (reader === 'xlsx') {
      const shared = parts.includes('xl/sharedStrings.xml')
        ? [...(await unzip('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match =>
            runsOf(match[1], 't').join(''),
          )
        : [];
      const sheets = parts.filter(part => /^xl\/worksheets\/sheet\d+\.xml$/.test(part)).sort(byNumber);
      const out: string[] = [];
      for (const [index, sheet] of sheets.entries())
        out.push(`Sheet ${index + 1}\n${sheetText(await unzip(sheet), shared)}`);
      text = out.join('\n\n');
    } else {
      const slides = parts.filter(part => /^ppt\/slides\/slide\d+\.xml$/.test(part)).sort(byNumber);
      const out: string[] = [];
      for (const [index, slide] of slides.entries())
        out.push(`Slide ${index + 1}\n${runsOf(await unzip(slide), 'a:t').join('\n')}`);
      text = out.join('\n\n');
    }
  }
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  return {
    text: clean.slice(0, WHATSAPP_DOCUMENT_TEXT_MAX),
    truncated: clean.length > WHATSAPP_DOCUMENT_TEXT_MAX,
  };
}
