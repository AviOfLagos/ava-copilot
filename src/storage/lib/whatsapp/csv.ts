/**
 * A small CSV reader for recipient lists: quoted fields (with commas, line breaks and doubled quotes inside),
 * a byte-order mark, CRLF or LF line ends, and a comma, semicolon or tab separator (spreadsheets in many
 * locales save with semicolons). Header names become keys: trimmed, lowercased, spaces as underscores.
 */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** The key a header name is known by in templates: "First Name" → "first_name". */
export function columnKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '');
}

/** The separator of the first line, counted outside quotes: the most frequent of comma, semicolon, tab. */
function detectSeparator(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char] += 1;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/** Splits CSV text into records of raw fields. */
export function parseCsvRecords(input: string, separator?: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const sep = separator ?? detectSeparator(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      i += 1;
      continue;
    }
    if (char === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (char === sep) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
    i += 1;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Blank lines carry nothing
  return records.filter(fields => fields.some(value => value.trim() !== ''));
}

/** Reads a CSV with a header row into keyed rows. Columns without a header are dropped. */
export function parseCsv(input: string): CsvTable {
  const [head, ...body] = parseCsvRecords(input);
  if (!head) return { headers: [], rows: [] };
  const headers = head.map(columnKey);
  const rows = body.map(fields => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header && !(header in row)) row[header] = (fields[index] ?? '').trim();
    });
    return row;
  });
  return { headers: headers.filter(Boolean), rows };
}

/** One field as CSV: quoted when it holds a separator, a quote or a line break. */
export function csvField(value: string): string {
  return /[",;\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows as CSV text, with a header row. */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map(row => row.map(csvField).join(',')).join('\r\n');
}
