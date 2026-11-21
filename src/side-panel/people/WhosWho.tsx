import { useMemo, useState } from 'react';
import { Check, Users } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { NameCandidate, Person, PersonSource } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi, TurnAddonProps } from '../registry';

/**
 * "Who's who" (docs/pm-desk.md 5.4): one question per name Ava could not settle, saying where it was seen, with
 * the match code found offered first. Every answer goes to the background (`people_answer`), which remembers it
 * for that workspace; the question then shows what was saved and is never asked again.
 */

type MessageKey = Parameters<typeof t>[0];

const SOURCE_LABEL: Record<PersonSource, MessageKey> = {
  meet: 'people_from_meet',
  spoken: 'people_from_spoken',
  calendar: 'people_from_calendar',
  whatsapp: 'people_from_whatsapp',
  slack: 'people_from_slack',
  gmail: 'people_from_gmail',
  github: 'people_from_github',
  chat: 'people_from_chat',
  note: 'people_from_note',
  task: 'people_from_task',
  avi: 'people_from_avi',
};

const OPEN = new Set<NameCandidate['status']>(['watching', 'ask', 'asked']);

/** Where a name was seen, in a few words: "Meet, Gmail · sent you an email". */
export function whereSeen(candidate: NameCandidate): string {
  const sources = [...new Set(candidate.sightings.map(sighting => sighting.source))].map(source =>
    t(SOURCE_LABEL[source] ?? 'people_from_avi'),
  );
  const contexts = [...new Set(candidate.sightings.map(sighting => sighting.context).filter(Boolean))].slice(0, 2);
  return [sources.join(', '), ...contexts].filter(Boolean).join(' · ');
}

const peopleFor = (people: Person[], workspaceId: string | null) =>
  people
    .filter(
      person => workspaceId === null || person.workspaceIds.length === 0 || person.workspaceIds.includes(workspaceId),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

export interface QuestionProps {
  candidate: NameCandidate;
  people: Person[];
  // The other name on the same card this one is likely short for
  like?: NameCandidate | null;
  api: PanelApi;
}

/** One question. Settled or "not a person", it shows what was saved instead of the buttons. */
export function WhosWhoQuestion({ candidate, people, like, api }: QuestionProps) {
  const [mode, setMode] = useState<'buttons' | 'pick' | 'new'>('buttons');
  const [picked, setPicked] = useState('');
  const [name, setName] = useState(candidate.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggested = candidate.suggestedPersonId
    ? (people.find(person => person.id === candidate.suggestedPersonId) ?? null)
    : null;
  const choices = useMemo(() => peopleFor(people, candidate.workspaceId), [people, candidate.workspaceId]);

  const send = async (answer: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api.request({ type: 'people_answer', candidateId: candidate.id, answer });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  if (candidate.status === 'settled' || candidate.status === 'not_person') {
    const person = people.find(item => item.id === candidate.personId);
    return (
      <li className="flex items-center gap-2 px-1 py-1 text-[12.5px]" data-testid="whoswho-answered">
        <Check className="text-primary size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">“{candidate.text}”</span>
        <span className="text-muted-foreground">
          {candidate.status === 'not_person' ? t('people_q_ignored') : t('people_q_saved', [person?.name ?? '…'])}
        </span>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="whoswho-question">
      <div>
        <p className="text-[13px] font-medium">“{candidate.text}”</p>
        <p className="text-muted-foreground text-[11.5px] leading-snug">{whereSeen(candidate)}</p>
      </div>
      {mode === 'buttons' && (
        <div className="flex flex-wrap gap-1.5">
          {suggested && (
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void send({ kind: 'same', personId: suggested.id })}>
              {t('people_q_yes', [suggested.name])}
            </Button>
          )}
          {like && !suggested && (
            <Button
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => void send({ kind: 'like', candidateId: like.id })}>
              {t('people_q_like', [like.text])}
            </Button>
          )}
          {choices.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('pick')}>
              {t('people_q_someoneElse')}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('new')}>
            {t('people_q_new')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ kind: 'not_person' })}>
            {t('people_q_notPerson')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send({ kind: 'not_person' })}>
            {t('people_q_me')}
          </Button>
        </div>
      )}
      {mode === 'pick' && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (picked) void send({ kind: 'same', personId: picked });
          }}>
          <select
            aria-label={t('people_q_pick')}
            value={picked}
            onChange={event => setPicked(event.target.value)}
            className="bg-secondary text-secondary-foreground min-w-0 flex-1 rounded-lg px-2 py-1 text-[12.5px]">
            <option value="">{t('people_q_pick')}</option>
            {choices.map(person => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" disabled={busy || !picked}>
            {t('people_save')}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode('buttons')}>
            {t('people_cancel')}
          </Button>
        </form>
      )}
      {mode === 'new' && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (name.trim()) void send({ kind: 'new', name: name.trim() });
          }}>
          <input
            aria-label={t('people_name_label')}
            value={name}
            maxLength={120}
            onChange={event => setName(event.target.value)}
            className="bg-secondary text-secondary-foreground min-w-0 flex-1 rounded-lg px-2 py-1 text-[12.5px]"
          />
          <Button size="sm" type="submit" disabled={busy || !name.trim()}>
            {t('people_save')}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode('buttons')}>
            {t('people_cancel')}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </li>
  );
}

/** A list of questions, each name offered the other name on the list it is likely short for. */
export function WhosWhoList({
  candidates,
  people,
  api,
}: {
  candidates: NameCandidate[];
  people: Person[];
  api: PanelApi;
}) {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return (
    <ul className="divide-border/60 flex flex-col divide-y">
      {candidates.map(candidate => {
        const like = candidate.likeCandidateId ? byId.get(candidate.likeCandidateId) : null;
        return (
          <WhosWhoQuestion
            key={candidate.id}
            candidate={candidate}
            people={people}
            like={like && OPEN.has(like.status) ? like : null}
            api={api}
          />
        );
      })}
    </ul>
  );
}

/** The card itself: the questions put on it, read live, so answers show at once. Nothing when it has none. */
export function WhosWhoCard({ cardId, api }: { cardId: string; api: PanelApi }) {
  const candidates = useLive(
    () => db.peopleNames.where('askedOn').equals(cardId).toArray(),
    [cardId],
    [] as NameCandidate[],
  );
  const people = useLive(() => db.people.toArray(), [], [] as Person[]);
  if (candidates.length === 0) return null;
  const open = candidates.filter(candidate => OPEN.has(candidate.status)).length;
  return (
    <section className="glass rounded-xl px-3 py-2.5" aria-label={t('people_card_title')} data-testid="whoswho-card">
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Users className="size-3.5" aria-hidden />
          {t('people_card_title')}
        </h2>
        {open === 0 && <span className="text-muted-foreground text-[11.5px]">{t('people_card_done')}</span>}
      </header>
      <WhosWhoList candidates={candidates} people={people} api={api} />
      <Button size="sm" variant="ghost" className="mt-1" onClick={() => api.go('people')}>
        {t('people_card_open')}
      </Button>
    </section>
  );
}

/** Under a meeting's note in its chat: the card for that call. */
export function MeetingWhosWho({ thread, requestSeq, api }: TurnAddonProps) {
  if (!thread.meetingId || requestSeq !== null || !api) return null;
  return <WhosWhoCard cardId={`meeting:${thread.meetingId}`} api={api} />;
}
