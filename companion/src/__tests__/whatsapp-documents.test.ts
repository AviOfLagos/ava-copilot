import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WHATSAPP_DOCUMENT_TEXT_MAX } from '@protocol';
import { runProcess } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';
import { documentText, readerFor, sheetText } from '../whatsapp/documents';
import { tempDir } from './helpers';

const ok = (stdout: string) => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
  cancelled: false,
  truncated: false,
  durationMs: 1,
});

describe('reading a WhatsApp document on the Mac', () => {
  it('picks the reader by the file’s name, else its type, and none for what it cannot read', () => {
    expect(readerFor('Report.PDF', null)).toBe('pdf');
    expect(readerFor(null, 'application/pdf')).toBe('pdf');
    expect(readerFor('letter.docx', null)).toBe('textutil');
    expect(readerFor('old.doc', 'application/msword')).toBe('textutil');
    expect(readerFor('sums.xlsx', null)).toBe('xlsx');
    expect(readerFor('deck.pptx', null)).toBe('pptx');
    expect(readerFor('notes.md', null)).toBe('plain');
    expect(readerFor('data', 'text/csv')).toBe('plain');
    expect(readerFor('app.dmg', 'application/x-apple-diskimage')).toBeNull();
    expect(readerFor('photo.heic', null)).toBeNull();
  });

  it('lays out a sheet as rows of cells, with shared and inline strings filled in', () => {
    const shared = ['Item', 'Panels', 'R&D'];
    const xml =
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1200</v></c></row>' +
      '<row r="3"><c r="A3"/></row><row r="4"><c r="A4" t="s"><v>2</v></c></row></sheetData>';
    expect(sheetText(xml, shared)).toBe('Item\tCost\nPanels\t1200\nR&D');
  });

  it('reads Excel and PowerPoint parts in order through unzip, the path always an argument', async () => {
    const dir = tempDir();
    const calls: string[][] = [];
    const parts: Record<string, string> = {
      'xl/sharedStrings.xml': '<sst><si><t>Total</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<row><c t="s"><v>0</v></c><c><v>5</v></c></row>',
      'xl/worksheets/sheet10.xml': '<row><c><v>10</v></c></row>',
      'xl/worksheets/sheet2.xml': '<row><c><v>2</v></c></row>',
    };
    const run: ProcessRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === '-Z1') return ok(Object.keys(parts).join('\n'));
      return ok(parts[args.at(-1)!] ?? '');
    };
    const path = join(dir.path, 'sums.xlsx');
    const read = await documentText(path, 'sums.xlsx', null, { run });
    expect(read.text).toBe('Sheet 1\nTotal\t5\n\nSheet 2\n2\n\nSheet 3\n10');
    expect(calls.every(call => call[0] === '/usr/bin/unzip' && call.includes('--') && call.includes(path))).toBe(true);

    const slides = await documentText(path, 'deck.pptx', null, {
      run: async (_command, args) =>
        args[0] === '-Z1'
          ? ok('ppt/slides/slide2.xml\nppt/slides/slide1.xml')
          : ok(args.at(-1) === 'ppt/slides/slide1.xml' ? '<a:t>Hello</a:t><a:t>&amp; welcome</a:t>' : '<a:t>Two</a:t>'),
    });
    expect(slides.text).toBe('Slide 1\nHello\n& welcome\n\nSlide 2\nTwo');
    dir.remove();
  });

  it('cuts a long text, and fails plainly when a reader does', async () => {
    const dir = tempDir();
    const path = join(dir.path, 'long.txt');
    writeFileSync(path, 'a'.repeat(WHATSAPP_DOCUMENT_TEXT_MAX + 10));
    const long = await documentText(path, 'long.txt', null, { run: runProcess });
    expect(long.text).toHaveLength(WHATSAPP_DOCUMENT_TEXT_MAX);
    expect(long.truncated).toBe(true);
    expect(await documentText(path, 'thing.bin', 'application/octet-stream', { run: runProcess })).toEqual({
      text: null,
      truncated: false,
    });
    await expect(
      documentText(path, 'x.pdf', null, { run: async () => ({ ...ok(''), code: 1 }) }),
    ).rejects.toThrow(/could not be read/);
    dir.remove();
  });

  it.skipIf(process.platform !== 'darwin')('reads a real Word file with textutil', async () => {
    const dir = tempDir();
    const txt = join(dir.path, 'a.txt');
    const docx = join(dir.path, 'a.docx');
    writeFileSync(txt, 'The roof takes twelve panels.\n');
    execFileSync('/usr/bin/textutil', ['-convert', 'docx', txt, '-output', docx]);
    expect((await documentText(docx, 'a.docx', null, { run: runProcess })).text).toBe('The roof takes twelve panels.');
    dir.remove();
  });
});
