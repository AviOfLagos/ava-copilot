import { t } from '@extension/i18n';
import { firstNameOf, localDay, meetingStore, nameKey, peopleStore } from '@extension/storage';
import type { NameCandidate, PeopleStore, Person } from '@extension/storage';
import { addInboxItem } from '../inbox/store';
import type { InboxDraft } from '../inbox/store';

/**
 * "Who's who" (docs/pm-desk.md 5.4): the names `observe` could not settle, asked about on one card after each
 * call and one Inbox card a day for everything else. At most six questions a card; the rest wait for the People
 * page. Each question says where the name was seen, and offers the likely match code found, never a guess acted on.
 */

export const PEOPLE_SOURCE = 'people';
export const MAX_QUESTIONS = 6;
export const DAILY_JOB = 'people_daily';
export const DAILY_KEY = 'people:daily';
// Early evening, when the day's names are in
export const DAILY_CRON = '30 17 * * *';

export const meetingCardId = (meetingId: string) => `meeting:${meetingId}`;
export const dailyCardId = (day: string) => `daily:${day}`;

const words = (text: string) =>
  nameKey(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 3);

/**
 * The one person a name likely is, by its words: "kunle-dev" and Kunle A. share "kunle". Only offered; the owner
 * answers. Two people sharing the word give no offer.
 */
export function likelyPerson(candidate: Pick<NameCandidate, 'text' | 'otherTexts' | 'workspaceId'>, people: Person[]) {
  const said = new Set([candidate.text, ...candidate.otherTexts.map(other => other.text)].flatMap(words));
  if (said.size === 0) return null;
  const fits = people.filter(
    person =>
      (candidate.workspaceId === null ||
        person.workspaceIds.length === 0 ||
        person.workspaceIds.includes(candidate.workspaceId)) &&
      [person.name, ...person.aliases.map(alias => alias.text)].some(name => said.has(firstNameOf(nameKey(name)))),
  );
  return fits.length === 1 ? fits[0] : null;
}

/**
 * Pairs a name used in speech with the call's roster name it is likely short for: "Ada" (given 2 tasks) and
 * "Adaeze O." (on the call). Only when exactly one roster name starts that way.
 */
export function likeOnCard(cards: NameCandidate[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const onCall = cards.filter(candidate => candidate.sightings.some(sighting => sighting.source === 'meet'));
  for (const spoken of cards) {
    if (onCall.includes(spoken) || spoken.suggestedPersonId) continue;
    const key = nameKey(spoken.text);
    if (!key || key.includes(' ')) continue;
    const matches = onCall.filter(other => firstNameOf(nameKey(other.text)).startsWith(key));
    if (matches.length === 1) pairs.set(spoken.id, matches[0].id);
  }
  return pairs;
}

/** One line of a card's text for the Inbox list: the name and where it was seen. */
export function questionLine(candidate: NameCandidate): string {
  const where = [...new Set(candidate.sightings.map(sighting => sighting.context).filter(Boolean))].slice(0, 2);
  return `“${candidate.text}”${where.length ? ` — ${where.join('; ')}` : ''}`;
}

export interface CardDeps {
  store: PeopleStore;
  addItem: (draft: InboxDraft) => Promise<unknown>;
  meetingTitle: (meetingId: string) => Promise<{ title: string; workspaceId: string | null } | null>;
}

const defaultDeps: CardDeps = {
  store: peopleStore,
  addItem: draft => addInboxItem(draft),
  meetingTitle: async meetingId => {
    const meeting = await meetingStore.get(meetingId);
    return meeting ? { title: meeting.note?.title || meeting.title, workspaceId: meeting.workspaceId ?? null } : null;
  },
};

/** Saves what code offers on a card: a likely person, or a likely name on the same card. */
async function offer(store: PeopleStore, cards: NameCandidate[]): Promise<void> {
  const people = await store.list();
  const pairs = likeOnCard(cards);
  for (const candidate of cards) {
    const suggestedPersonId = candidate.suggestedPersonId ?? likelyPerson(candidate, people)?.id ?? null;
    const likeCandidateId = pairs.get(candidate.id) ?? null;
    if (suggestedPersonId !== candidate.suggestedPersonId || likeCandidateId !== (candidate.likeCandidateId ?? null)) {
      await store.db.peopleNames.update(candidate.id, { suggestedPersonId, likeCandidateId });
    }
  }
}

/** The card after a call: its unsettled names, in the meeting's chat and the Inbox. Nothing when all are known. */
export async function postMeetingCard(meetingId: string, deps: CardDeps = defaultDeps): Promise<number> {
  const cards = await deps.store.readyToAsk({ meetingId, limit: MAX_QUESTIONS });
  if (cards.length === 0) return 0;
  const cardId = meetingCardId(meetingId);
  await offer(deps.store, cards);
  await deps.store.markAsked(
    cards.map(candidate => candidate.id),
    cardId,
  );
  const meeting = await deps.meetingTitle(meetingId);
  await deps.addItem({
    source: PEOPLE_SOURCE,
    externalId: cardId,
    kind: 'alert',
    title: t('people_card_meetingTitle', [meeting?.title || t('meeting_untitled')]),
    body: cards.map(questionLine).join('\n'),
    priority: 'normal',
    workspaceId: meeting?.workspaceId ?? null,
  });
  return cards.length;
}

/** The day's card: names from everywhere else, most-seen first. Once a day; nothing when there is nothing to ask. */
export async function postDailyCard(day = localDay(), deps: CardDeps = defaultDeps): Promise<number> {
  const cardId = dailyCardId(day);
  if ((await deps.store.onCard(cardId)).length > 0) return 0;
  const cards = await deps.store.readyToAsk({ limit: MAX_QUESTIONS });
  if (cards.length === 0) return 0;
  await offer(deps.store, cards);
  await deps.store.markAsked(
    cards.map(candidate => candidate.id),
    cardId,
  );
  await deps.addItem({
    source: PEOPLE_SOURCE,
    externalId: cardId,
    kind: 'alert',
    title: t('people_card_dailyTitle', [String(cards.length)]),
    body: cards.map(questionLine).join('\n'),
    priority: 'low',
  });
  return cards.length;
}
