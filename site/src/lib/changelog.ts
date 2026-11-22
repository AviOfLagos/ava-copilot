/*
 * The changelog, read from the repository's own CHANGELOG.md at build time, so the page and the file cannot drift.
 * The format is described at the top of that file: `## <dates> · <label>`, `### <theme>`, `- <line>. ([#1](url))`.
 */
import raw from '../../../CHANGELOG.md?raw';

export interface ChangePr {
  n: number;
  url: string;
}

export interface ChangeItem {
  /** Safe HTML: escaped text with `code` and **bold** only. */
  html: string;
  prs: ChangePr[];
}

export interface ChangeGroup {
  title: string;
  items: ChangeItem[];
}

export interface ChangeEntry {
  id: string;
  dates: string;
  label: string;
  /** Merged, but not in the downloadable build yet. */
  next: boolean;
  intro: string;
  groups: ChangeGroup[];
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inline = (text: string) =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

const PR_TAIL = /\s*\(((?:\[#\d+\]\([^)]+\)(?:,\s*)?)+)\)\s*$/;
const PR_LINK = /\[#(\d+)\]\(([^)]+)\)/g;

function parseItem(line: string): ChangeItem {
  const tail = PR_TAIL.exec(line);
  const prs: ChangePr[] = tail ? [...tail[1].matchAll(PR_LINK)].map(m => ({ n: Number(m[1]), url: m[2] })) : [];
  const text = tail ? line.slice(0, tail.index) : line;
  return { html: inline(text), prs };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function parseChangelog(source: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  let entry: ChangeEntry | undefined;
  let group: ChangeGroup | undefined;
  for (const line of source.split('\n')) {
    if (line.startsWith('## ')) {
      const [dates, ...rest] = line.slice(3).split(' · ');
      const label = rest.join(' · ');
      entry = {
        id: slug(dates),
        dates: dates.trim(),
        label: label.trim(),
        next: /^next release/i.test(label.trim()),
        intro: '',
        groups: [],
      };
      entries.push(entry);
      group = undefined;
    } else if (entry && line.startsWith('### ')) {
      group = { title: line.slice(4).trim(), items: [] };
      entry.groups.push(group);
    } else if (entry && line.startsWith('- ')) {
      if (!group) {
        group = { title: '', items: [] };
        entry.groups.push(group);
      }
      group.items.push(parseItem(line.slice(2).trim()));
    } else if (entry && !group && line.trim()) {
      entry.intro = `${entry.intro} ${line.trim()}`.trim();
    }
  }
  return entries;
}

export const changelog = parseChangelog(raw);
