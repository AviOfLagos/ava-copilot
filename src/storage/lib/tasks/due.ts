// A due date from the words used ("by Friday", "tomorrow", "Nov 28"), worked out in code from the day they were
// said. Words it cannot read give no date: the words are kept (dueText) and nothing is guessed.

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "2026-11-27" in local time. */
export function isoDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const startOfDay = (at: number) => {
  const date = new Date(at);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
};

const weekdayOf = (word: string) => WEEKDAYS.findIndex(day => word === day || word === day.slice(0, 3));
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
// A month's name or its start ("nov", "novem"), never a word that only begins like one ("Janet", "decks")
const monthOf = (word: string) =>
  word.length >= 3 ? MONTH_NAMES.findIndex(month => month.startsWith(word.replace(/\.$/, ''))) : -1;

/** A real calendar day, or null ("Feb 30" is none). */
function dayOf(year: number, month: number, day: number): string | null {
  const date = new Date(year, month, day, 12);
  return date.getMonth() === month && date.getDate() === day ? isoDay(date.getTime()) : null;
}

/** The next time a month and day comes round from `said` (that day itself included). */
function nextMonthDay(month: number, day: number, said: number): string | null {
  const from = new Date(said);
  const thisYear = dayOf(from.getFullYear(), month, day);
  if (thisYear && thisYear >= isoDay(said)) return thisYear;
  return dayOf(from.getFullYear() + 1, month, day);
}

/**
 * The ISO date the words name, counted from the day they were said, or undefined.
 * - "today", "tonight", "tomorrow", "in 3 days", "in 2 weeks";
 * - a weekday ("Friday", "by Fri"): the next one, that same day when said on it; "next Friday" is never that day;
 * - "end of the week" is Friday, "end of the month" its last day;
 * - "2026-11-28", "Nov 28", "28 November", "November 28th": the next time that day comes round.
 */
export function dueFromText(text: string | null | undefined, said: number): string | undefined {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return undefined;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(words);
  if (iso) return dayOf(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) ?? undefined;

  const noon = startOfDay(said);
  if (/\b(today|tonight|this evening|end of (the )?day|eod)\b/.test(words)) return isoDay(noon);
  if (/\b(tomorrow|tmrw)\b/.test(words)) return isoDay(noon + DAY);

  const within = /\bin (\d{1,3}|a|one|two|three) (day|days|week|weeks)\b/.exec(words);
  if (within) {
    const count = { a: 1, one: 1, two: 2, three: 3 }[within[1]] ?? Number(within[1]);
    return isoDay(noon + count * (within[2].startsWith('week') ? 7 : 1) * DAY);
  }

  if (/\b(end of (the )?week|eow|this week)\b/.test(words)) {
    const today = new Date(noon).getDay();
    return isoDay(noon + ((5 - today + 7) % 7) * DAY);
  }
  if (/\b(end of (the )?month|eom)\b/.test(words)) {
    const date = new Date(noon);
    return isoDay(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12).getTime());
  }

  // "Nov 28", "November 28th", "28 Nov", "28th of November"
  const monthFirst = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(words);
  if (monthFirst && monthOf(monthFirst[1]) >= 0) {
    return nextMonthDay(monthOf(monthFirst[1]), Number(monthFirst[2]), said) ?? undefined;
  }
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(words);
  if (dayFirst && monthOf(dayFirst[2]) >= 0) {
    return nextMonthDay(monthOf(dayFirst[2]), Number(dayFirst[1]), said) ?? undefined;
  }

  const weekday =
    /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/.exec(
      words,
    );
  if (weekday) {
    const target = weekdayOf(weekday[2].slice(0, 3));
    const today = new Date(noon).getDay();
    let ahead = (target - today + 7) % 7;
    if (ahead === 0 && weekday[1]) ahead = 7;
    return isoDay(noon + ahead * DAY);
  }
  return undefined;
}
