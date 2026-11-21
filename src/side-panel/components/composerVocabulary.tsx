import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { suggestRule } from '@extension/storage';
import { t } from '@extension/i18n';

/**
 * The vocabulary in the composer (docs/pm-desk.md, Part 4.4): corrected words underlined faintly for a few seconds
 * (click one to put the old word back, or never change it), "Did you mean …?" for a word that was left alone, and a
 * quiet offer to keep a correction the user made by hand. Nothing here changes the text by itself.
 */

/** What the background found in dictated words, as it sends it. */
export interface DictationVocabulary {
  changes: { from: string; to: string; at: number }[];
  unsure: { word: string; at: number; options: string[] }[];
}

export interface VocabularyApi {
  // Offers a correction as a rule: `confirmed` when the user tapped; made twice without a tap it is saved anyway
  learn: (from: string, to: string, confirmed: boolean) => Promise<{ saved: boolean; automatic?: boolean }>;
  never: (word: string) => Promise<void>;
}

interface Mark {
  from: string;
  to: string;
  start: number;
  end: number;
}
interface Doubt {
  word: string;
  start: number;
  end: number;
  options: string[];
}
interface Marks {
  // The text these ranges belong to: any edit and they no longer do
  text: string;
  changes: Mark[];
  unsure: Doubt[];
}

const UNDERLINE_MS = 8000;
const NOTE_MS = 6000;
const RULE_AFTER_MS = 700;

const ruleKey = (rule: { from: string; to: string }) => `${rule.from.toLowerCase()}→${rule.to.toLowerCase()}`;

export function useComposerVocabulary(
  text: string,
  setText: (value: string) => void,
  vocabulary: VocabularyApi | undefined,
  areaRef: RefObject<HTMLTextAreaElement>,
) {
  // The panel hands over a new object on each render; only whether there is one, and the latest, matter
  const apiRef = useRef(vocabulary);
  apiRef.current = vocabulary;
  const hasApi = vocabulary !== undefined;
  const api = vocabulary;
  // The text as dictated, to see what the user then changed
  const baseline = useRef<string | null>(null);
  const [marks, setMarks] = useState<Marks | null>(null);
  const [rule, setRule] = useState<{ from: string; to: string } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const mirrorRef = useRef<HTMLDivElement>(null);

  const valid = marks !== null && marks.text === text;
  const changes = valid ? marks.changes : [];
  const doubts = valid ? marks.unsure : [];

  // The underline fades after a few seconds
  useEffect(() => {
    if (!marks || marks.changes.length === 0) return;
    const timer = window.setTimeout(() => setMarks(current => current && { ...current, changes: [] }), UNDERLINE_MS);
    return () => window.clearTimeout(timer);
  }, [marks]);

  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  // A hand-made correction of dictated words is offered as a rule, once the user pauses
  useEffect(() => {
    if (!hasApi || baseline.current === null || text === baseline.current) {
      setRule(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const found = baseline.current === null ? null : suggestRule(baseline.current, text);
      setRule(found && !dismissed.current.has(ruleKey(found)) ? found : null);
    }, RULE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [text, hasApi]);

  /** Dictated words went into the box: `joined` is the whole text now, `offset` where the words start in it. */
  const onDictated = useCallback((joined: string, offset: number, found?: DictationVocabulary) => {
    baseline.current = joined;
    setPicked(null);
    setRule(null);
    if (!found) {
      setMarks(null);
      return;
    }
    const placed = <T extends { at: number }>(item: T, length: number) => ({
      start: item.at + offset,
      end: item.at + offset + length,
    });
    setMarks({
      text: joined,
      changes: found.changes
        .map(change => ({ from: change.from, to: change.to, ...placed(change, change.to.length) }))
        .filter(mark => joined.slice(mark.start, mark.end) === mark.to),
      unsure: found.unsure
        .map(item => ({ word: item.word, options: item.options, ...placed(item, item.word.length) }))
        .filter(item => joined.slice(item.start, item.end) === item.word && item.options.length > 0),
    });
  }, []);

  /** Sending: a correction the user made and did not answer is counted; made twice, it is saved and says so. */
  const beforeSend = useCallback((sent: string) => {
    const live = apiRef.current;
    const found = live && baseline.current !== null ? suggestRule(baseline.current, sent) : null;
    baseline.current = null;
    setMarks(null);
    setRule(null);
    setPicked(null);
    if (!live || !found || dismissed.current.has(ruleKey(found))) return;
    void live
      .learn(found.from, found.to, false)
      .then(result => result.saved && result.automatic && setNote(t('vocab_chip_saved', [found.from, found.to])))
      .catch(() => {});
  }, []);

  /** The caret is on a corrected word: offer to put the old one back. */
  const onCaret = useCallback(
    (area: HTMLTextAreaElement) => {
      if (!valid || area.selectionStart !== area.selectionEnd) return setPicked(null);
      const caret = area.selectionStart;
      const index = marks.changes.findIndex(mark => caret >= mark.start && caret <= mark.end);
      setPicked(index >= 0 ? index : null);
    },
    [valid, marks],
  );

  const replace = (start: number, end: number, value: string) => {
    const next = text.slice(0, start) + value + text.slice(end);
    // What the user did on purpose here is not a rule to learn
    baseline.current = next;
    setMarks(null);
    setPicked(null);
    setText(next);
    window.requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const syncScroll = (area: HTMLTextAreaElement) => {
    if (mirrorRef.current) mirrorRef.current.scrollTop = area.scrollTop;
  };

  const button = 'hover:bg-accent rounded-full border px-2 py-0.5 text-[11.5px] transition-colors';
  let chip: ReactNode = null;
  const mark = picked !== null ? changes[picked] : undefined;
  if (mark) {
    chip = (
      <>
        <span>{t('vocab_chip_changed', [mark.from, mark.to])}</span>
        <button type="button" className={button} onClick={() => replace(mark.start, mark.end, mark.from)}>
          {t('vocab_chip_undo', [mark.from])}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            void api?.never(mark.from).catch(() => {});
            replace(mark.start, mark.end, mark.from);
          }}>
          {t('vocab_chip_never')}
        </button>
      </>
    );
  } else if (rule) {
    chip = (
      <>
        <span>{t('vocab_chip_rule', [rule.to, rule.from])}</span>
        <button
          type="button"
          className={button}
          onClick={() => {
            const answered = rule;
            setRule(null);
            baseline.current = text;
            void api
              ?.learn(answered.from, answered.to, true)
              .then(result => result.saved && setNote(t('vocab_chip_saved', [answered.from, answered.to])))
              .catch(() => {});
          }}>
          {t('vocab_chip_yes')}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            dismissed.current.add(ruleKey(rule));
            setRule(null);
          }}>
          {t('vocab_chip_no')}
        </button>
      </>
    );
  } else if (doubts.length > 0) {
    const doubt = doubts[0];
    chip = (
      <>
        <span>{t('vocab_chip_unsure', [doubt.options[0]])}</span>
        {doubt.options.slice(0, 3).map(option => (
          <button
            key={option}
            type="button"
            className={button}
            onClick={() => replace(doubt.start, doubt.end, option)}
            title={`${doubt.word} → ${option}`}>
            {doubt.options.length > 1 ? option : t('vocab_chip_use')}
          </button>
        ))}
        <button
          type="button"
          className={button}
          onClick={() => setMarks(current => current && { ...current, unsure: current.unsure.slice(1) })}>
          {t('vocab_chip_no')}
        </button>
      </>
    );
  } else if (note) {
    chip = <span>{note}</span>;
  }

  return {
    onDictated,
    beforeSend,
    onCaret,
    syncScroll,
    mirrorRef,
    // The text with its corrected words marked, for the layer behind the text box
    mirror: changes.length > 0 ? markedText(text, changes) : null,
    chip: chip && (
      <div
        role="status"
        data-testid="vocab-chip"
        className="text-muted-foreground flex flex-wrap items-center gap-1.5 px-2 text-[12px]">
        {chip}
      </div>
    ),
  };
}

/** The text cut at the corrected words, each one in a mark that draws the faint underline. */
function markedText(text: string, changes: Mark[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  [...changes]
    .sort((a, b) => a.start - b.start)
    .forEach((change, index) => {
      if (change.start < at) return;
      parts.push(text.slice(at, change.start));
      parts.push(
        <mark key={index} className="vocab-mark">
          {text.slice(change.start, change.end)}
        </mark>,
      );
      at = change.end;
    });
  parts.push(text.slice(at));
  return parts;
}
