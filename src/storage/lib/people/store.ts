import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import {
  cleanEmail,
  cleanHandle,
  cleanName,
  cleanPhone,
  firstNameOf,
  handleFits,
  handleKey,
  isSingleWord,
  nameKey,
  newPeopleId,
  scopedKey,
} from './names';
import type {
  CandidateAnswer,
  HandleKind,
  NameCandidate,
  NameSighting,
  ObserveInput,
  ObserveResult,
  Person,
  PersonAlias,
  PersonHandle,
  PersonSource,
  ResolveResult,
  ResolveVia,
} from './types';

/**
 * The people store (docs/pm-desk.md, Part 5). `observe` is the one way in, `resolve` the one way to look a name
 * up, and both are plain code: the same names in the same order always give the same answer.
 *
 * Rules that keep two people apart:
 * - An email, phone or handle that already belongs to one person identifies them whatever name was used.
 * - A name alone never creates a person, and never gives a person a new email, phone or handle (anyone can
 *   write any display name on an email or an invite). It is offered as a likely match for the owner to confirm.
 * - A first-name match only ever resolves; it never adds an alias or an address, so a second "Ada" joining the
 *   workspace later is asked about rather than folded into the first.
 * - An alias saved for one workspace resolves only in that workspace.
 */

const MAX_SEEN = 20;
const MAX_SIGHTINGS = 20;
const MAX_ALIASES = 60;
const MAX_IDS = 20;

// Handles that mean the same person everywhere (a GitHub login); a Slack id belongs to one Slack workspace
const GLOBAL_HANDLES: HandleKind[] = ['github', 'whatsapp', 'x', 'linkedin'];

interface Identifiers {
  emails: string[];
  phones: string[];
  handles: PersonHandle[];
}

/** The index keys of a person, recomputed from what they hold. */
export function withKeys(person: Person): Person {
  return {
    ...person,
    nameKey: nameKey(person.name),
    aliasKeys: [...new Set(person.aliases.map(alias => scopedKey(alias.workspaceId, nameKey(alias.text))))],
    handleKeys: [...new Set(person.handles.map(handleKey))],
  };
}

export function newPerson(name: string, now = Date.now()): Person {
  return withKeys({
    id: newPeopleId('per_'),
    name: cleanName(name),
    aliases: [],
    handles: [],
    emails: [],
    phones: [],
    workspaceIds: [],
    seen: [],
    createdAt: now,
    updatedAt: now,
    nameKey: '',
    aliasKeys: [],
    handleKeys: [],
  });
}

const addUnique = <T>(list: T[], value: T | null | undefined) =>
  value === null || value === undefined || list.includes(value) ? list : [...list, value];

function addSeen(person: Person, source: PersonSource, workspaceId: string | null, at: number): Person['seen'] {
  const others = person.seen.filter(entry => !(entry.source === source && entry.workspaceId === workspaceId));
  return [...others, { source, workspaceId, at }].sort((a, b) => b.at - a.at).slice(0, MAX_SEEN);
}

function hasAlias(person: Person, text: string, workspaceId: string | null): boolean {
  const key = nameKey(text);
  return (
    key === person.nameKey ||
    person.aliasKeys.includes(scopedKey(workspaceId, key)) ||
    person.aliasKeys.includes(scopedKey(null, key))
  );
}

function addAliasTo(person: Person, text: string, workspaceId: string | null, from: PersonSource): Person {
  const clean = cleanName(text);
  if (!nameKey(clean) || hasAlias(person, clean, workspaceId) || person.aliases.length >= MAX_ALIASES) return person;
  return withKeys({ ...person, aliases: [...person.aliases, { text: clean, workspaceId, from }] });
}

function addIdentifiers(person: Person, ids: Identifiers): Person {
  let handles = person.handles;
  for (const handle of ids.handles) {
    if (!handles.some(other => handleKey(other) === handleKey(handle) && other.workspaceId === handle.workspaceId)) {
      handles = [...handles, handle];
    }
  }
  return withKeys({
    ...person,
    emails: ids.emails.reduce(addUnique, person.emails).slice(0, MAX_IDS),
    phones: ids.phones.reduce(addUnique, person.phones).slice(0, MAX_IDS),
    handles: handles.slice(0, MAX_IDS),
  });
}

/** Whether `ids` holds an email, phone or handle the person does not have. */
function bringsNew(person: Person, ids: Identifiers, workspaceId: string | null): boolean {
  return (
    ids.emails.some(email => !person.emails.includes(email)) ||
    ids.phones.some(phone => !person.phones.includes(phone)) ||
    ids.handles.some(
      handle => !person.handles.some(other => handleKey(other) === handleKey(handle) && handleFits(other, workspaceId)),
    )
  );
}

const hasAny = (ids: Identifiers) => ids.emails.length + ids.phones.length + ids.handles.length > 0;

function identifiersOf(input: ObserveInput, workspaceId: string | null): Identifiers {
  const email = cleanEmail(input.email);
  const phone = cleanPhone(input.phone);
  const value = input.handle ? cleanHandle(input.handle.kind, input.handle.value) : null;
  const handles: PersonHandle[] =
    input.handle && value
      ? [
          {
            kind: input.handle.kind,
            value,
            workspaceId: GLOBAL_HANDLES.includes(input.handle.kind) ? null : workspaceId,
          },
        ]
      : [];
  return { emails: email ? [email] : [], phones: phone ? [phone] : [], handles };
}

/** Plain-language "where it was seen" for a card line, e.g. "Slack, Gmail · 3 times". */
export function candidateSources(candidate: Pick<NameCandidate, 'sightings'>): PersonSource[] {
  return [...new Set(candidate.sightings.map(sighting => sighting.source))];
}

/** Where a name seen in `workspaceId` is saved for a person: there, or in each of theirs when it has none. */
function aliasWorkspaces(workspaceId: string | null, personWorkspaces: string[]): (string | null)[] {
  if (workspaceId !== null) return [workspaceId];
  return personWorkspaces.length ? personWorkspaces : [null];
}

/** True when the sighting's address, phone or handle differs from the one the question already holds. */
function conflicts(candidate: Pick<NameCandidate, 'emails' | 'phones' | 'handles'>, ids: Identifiers): boolean {
  const differs = (have: string[], seen: string[]) =>
    have.length > 0 && seen.length > 0 && !seen.some(value => have.includes(value));
  if (differs(candidate.emails, ids.emails) || differs(candidate.phones, ids.phones)) return true;
  return ids.handles.some(
    handle =>
      candidate.handles.some(other => other.kind === handle.kind) &&
      !candidate.handles.some(other => handleKey(other) === handleKey(handle)),
  );
}

const firstIdentifier = (ids: Identifiers) =>
  ids.emails[0] ?? ids.phones[0] ?? (ids.handles[0] ? handleKey(ids.handles[0]) : '');

export function createPeopleStore(db: AviCopilotDb = defaultDb) {
  const tx = <T>(work: () => Promise<T>) => db.transaction('rw', db.people, db.peopleNames, work);

  /** The people an email, phone or handle already belongs to. */
  async function byIdentifier(ids: Identifiers, workspaceId: string | null): Promise<Person[]> {
    const found = new Map<string, Person>();
    for (const email of ids.emails) {
      for (const person of await db.people.where('emails').equals(email).toArray()) found.set(person.id, person);
    }
    for (const phone of ids.phones) {
      for (const person of await db.people.where('phones').equals(phone).toArray()) found.set(person.id, person);
    }
    for (const handle of ids.handles) {
      const key = handleKey(handle);
      for (const person of await db.people.where('handleKeys').equals(key).toArray()) {
        if (person.handles.some(other => handleKey(other) === key && handleFits(other, workspaceId))) {
          found.set(person.id, person);
        }
      }
    }
    return [...found.values()];
  }

  /** People who count as belonging to a workspace: in it, or in none yet (a person the owner added by hand). */
  const inWorkspace = (person: Person, workspaceId: string | null) =>
    workspaceId === null || person.workspaceIds.length === 0 || person.workspaceIds.includes(workspaceId);

  /**
   * Who a name means in a workspace. In order: the name the owner calls someone in this workspace; an alias saved
   * for this workspace; an alias saved for everywhere; a unique first-name match among this workspace's people;
   * else nobody. Several matches at one step give the candidates, never a guess.
   */
  async function resolve(text: string, options: { workspaceId: string | null }): Promise<ResolveResult> {
    const key = nameKey(text);
    const workspaceId = options.workspaceId ?? null;
    if (!key) return null;
    const pick = (list: Person[], via: ResolveVia): ResolveResult | undefined => {
      if (list.length === 1) return { person: list[0], via };
      if (list.length > 1) return { candidates: list };
      return undefined;
    };
    const named = (await db.people.where('nameKey').equals(key).toArray()).filter(person =>
      inWorkspace(person, workspaceId),
    );
    const byName = pick(named, 'name');
    if (byName !== undefined) return byName;
    if (workspaceId !== null) {
      const here = pick(await db.people.where('aliasKeys').equals(scopedKey(workspaceId, key)).toArray(), 'alias');
      if (here !== undefined) return here;
    }
    const everywhere = pick(
      await db.people.where('aliasKeys').equals(scopedKey(null, key)).toArray(),
      'alias_everywhere',
    );
    if (everywhere !== undefined) return everywhere;
    if (workspaceId !== null && isSingleWord(key)) {
      const first = (await db.people.where('workspaceIds').equals(workspaceId).toArray()).filter(
        person => firstNameOf(person.nameKey) === key,
      );
      const byFirst = pick(first, 'first_name');
      if (byFirst !== undefined) return byFirst;
    }
    return null;
  }

  async function candidateByIdentifier(ids: Identifiers, workspaceId: string | null) {
    for (const email of ids.emails) {
      const found = await db.peopleNames.where('emails').equals(email).first();
      if (found) return found;
    }
    for (const phone of ids.phones) {
      const found = await db.peopleNames.where('phones').equals(phone).first();
      if (found) return found;
    }
    for (const handle of ids.handles) {
      const key = handleKey(handle);
      const found = (await db.peopleNames.where('handleKeys').equals(key).toArray()).find(candidate =>
        candidate.handles.some(other => handleKey(other) === key && handleFits(other, workspaceId)),
      );
      if (found) return found;
    }
    return undefined;
  }

  async function recordOnPerson(
    person: Person,
    via: ResolveVia,
    input: ObserveInput,
    text: string,
    ids: Identifiers,
    now: number,
  ): Promise<void> {
    const workspaceId = input.workspaceId ?? null;
    let next: Person = {
      ...person,
      seen: addSeen(person, input.source, workspaceId, now),
      workspaceIds: workspaceId ? addUnique(person.workspaceIds, workspaceId) : person.workspaceIds,
      lastSeenAt: now,
      updatedAt: now,
    };
    // An address or handle is added only when the person was found by one; a name match never adds one
    if (via === 'identifier') {
      next = addIdentifiers(next, ids);
      // The name used with a known address becomes an alias in the sighting's workspace, or, for a sighting with
      // none (an inbox, an invite), in each of the person's workspaces: never "everywhere" for someone who has one.
      // Not where it already means someone else.
      for (const target of aliasWorkspaces(workspaceId, next.workspaceIds)) {
        if (!text || hasAlias(next, text, target)) continue;
        const other = await resolve(text, { workspaceId: target });
        if (other === null || ('person' in other && other.person.id === person.id)) {
          next = addAliasTo(next, text, target, input.source);
        }
      }
    }
    await db.people.put(withKeys(next));
  }

  async function upsertCandidate(
    input: ObserveInput,
    text: string,
    ids: Identifiers,
    offered: { suggested: Person | null; ambiguous: Person[] },
    byKey: NameCandidate | undefined,
    now: number,
  ): Promise<ObserveResult> {
    const workspaceId = input.workspaceId ?? null;
    const key = nameKey(text);
    let match = offered;
    const linked = hasAny(ids) ? await candidateByIdentifier(ids, workspaceId) : undefined;
    let candidate = linked ?? byKey;
    if (candidate?.status === 'not_person') return { kind: 'ignored' };
    // A different address under a name already asked about, or under a name already settled, is someone (or
    // something) else until the owner says otherwise: its own question, never pooled into the first one
    let separate = false;
    if (!linked && byKey && hasAny(ids)) {
      const settledTo = byKey.status === 'settled' && byKey.personId ? await db.people.get(byKey.personId) : undefined;
      if (conflicts(byKey, ids) || settledTo) {
        candidate = undefined;
        separate = true;
        if (settledTo && !match.suggested) match = { ...match, suggested: settledTo };
      }
    }
    if (
      linked &&
      byKey &&
      byKey.id !== linked.id &&
      ['watching', 'ask', 'asked'].includes(byKey.status) &&
      !conflicts(byKey, linked)
    ) {
      // The address shows the name's own question is about the same someone: one question, not two
      candidate = foldCandidate(linked, byKey);
      await db.peopleNames.delete(byKey.id);
    }
    if (candidate?.status === 'settled') {
      // Its person was removed or no longer matches: it is unsettled again
      candidate = { ...candidate, status: 'watching', personId: null, askedOn: null };
    }
    if (!candidate && !key) return { kind: 'skipped' };
    const fresh = !candidate;
    let next: NameCandidate = candidate ?? {
      id: newPeopleId('nam_'),
      key: separate ? `${scopedKey(workspaceId, key)}#${firstIdentifier(ids)}` : scopedKey(workspaceId, key),
      text,
      otherTexts: [],
      workspaceId,
      emails: [],
      phones: [],
      handles: [],
      handleKeys: [],
      sightings: [],
      count: 0,
      taskIds: [],
      tasks: 0,
      meetingIds: [],
      suggestedPersonId: null,
      candidatePersonIds: [],
      status: 'watching',
      askedOn: null,
      personId: null,
      firstAt: now,
      lastAt: now,
    };
    if (!fresh && key && nameKey(next.text) !== key && !next.otherTexts.some(other => nameKey(other.text) === key)) {
      next = { ...next, otherTexts: [...next.otherTexts, { text, workspaceId }].slice(0, 20) };
    }
    const repeat = !!input.ref && next.sightings.some(seen => seen.ref === input.ref && seen.source === input.source);
    const sighting: NameSighting = {
      source: input.source,
      at: now,
      ...(input.context ? { context: input.context.slice(0, 160) } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
    };
    let handles = next.handles;
    for (const handle of ids.handles) {
      if (!handles.some(other => handleKey(other) === handleKey(handle))) handles = [...handles, handle];
    }
    const taskIds = input.taskId ? addUnique(next.taskIds, input.taskId) : next.taskIds;
    next = {
      ...next,
      emails: ids.emails.reduce(addUnique, next.emails),
      phones: ids.phones.reduce(addUnique, next.phones),
      handles,
      handleKeys: [...new Set(handles.map(handleKey))],
      sightings: repeat
        ? next.sightings.map(seen =>
            seen.ref === input.ref && seen.source === input.source ? { ...seen, ...sighting } : seen,
          )
        : [...next.sightings, sighting].slice(-MAX_SIGHTINGS),
      count: repeat ? next.count : next.count + 1,
      taskIds,
      tasks: next.tasks + (taskIds.length > next.taskIds.length ? 1 : 0) + (repeat ? 0 : Math.max(0, input.tasks ?? 0)),
      meetingIds: input.meetingId ? addUnique(next.meetingIds, input.meetingId) : next.meetingIds,
      suggestedPersonId: next.suggestedPersonId ?? match.suggested?.id ?? null,
      candidatePersonIds: match.ambiguous.length
        ? [...new Set([...next.candidatePersonIds, ...match.ambiguous.map(person => person.id)])]
        : next.candidatePersonIds,
      lastAt: now,
    };
    // A bare name seen once is only watched; twice, with a task, or on a call with the owner, it is asked about
    if (next.status === 'watching' && (next.count >= 2 || next.tasks > 0 || input.source === 'meet')) {
      next = { ...next, status: 'ask' };
    }
    await db.peopleNames.put(next);
    return { kind: 'candidate', candidateId: next.id, asking: next.status === 'ask' || next.status === 'asked' };
  }

  /** `from` folded into `into`: its spellings, sightings, tasks and calls. */
  function foldCandidate(into: NameCandidate, from: NameCandidate): NameCandidate {
    const texts = [...into.otherTexts];
    for (const spelling of [{ text: from.text, workspaceId: from.workspaceId }, ...from.otherTexts]) {
      const key = nameKey(spelling.text);
      if (key === nameKey(into.text) && spelling.workspaceId === into.workspaceId) continue;
      if (!texts.some(other => nameKey(other.text) === key && other.workspaceId === spelling.workspaceId)) {
        texts.push(spelling);
      }
    }
    const refs = new Set(into.sightings.map(seen => `${seen.source}|${seen.ref ?? seen.at}`));
    const extra = from.sightings.filter(seen => !refs.has(`${seen.source}|${seen.ref ?? seen.at}`));
    const statusRank = { watching: 0, ask: 1, asked: 2, settled: 3, not_person: 4 } as const;
    return {
      ...into,
      otherTexts: texts.slice(0, 20),
      sightings: [...into.sightings, ...extra].sort((a, b) => a.at - b.at).slice(-MAX_SIGHTINGS),
      count: into.count + extra.length,
      taskIds: from.taskIds.reduce(addUnique, into.taskIds),
      tasks: into.tasks + from.tasks,
      meetingIds: from.meetingIds.reduce(addUnique, into.meetingIds),
      suggestedPersonId: into.suggestedPersonId ?? from.suggestedPersonId,
      status: statusRank[from.status] > statusRank[into.status] ? from.status : into.status,
      askedOn: into.askedOn ?? from.askedOn,
      firstAt: Math.min(into.firstAt, from.firstAt),
      lastAt: Math.max(into.lastAt, from.lastAt),
    };
  }

  const store = {
    db,
    resolve,

    /**
     * Records that a name was seen. A known email, phone or handle identifies the person whatever name was used;
     * otherwise the name is resolved. A name nobody (or more than one person) answers to is kept as a candidate.
     */
    async observe(input: ObserveInput, now = Date.now()): Promise<ObserveResult> {
      const workspaceId = input.workspaceId ?? null;
      const text = cleanName(input.text);
      const key = nameKey(text);
      const ids = identifiersOf(input, workspaceId);
      if (!key && !hasAny(ids)) return { kind: 'skipped' };
      return tx(async () => {
        const byKey = key ? await db.peopleNames.where('key').equals(scopedKey(workspaceId, key)).first() : undefined;
        if (byKey?.status === 'not_person') return { kind: 'ignored' } as const;

        const known = hasAny(ids) ? await byIdentifier(ids, workspaceId) : [];
        let suggested: Person | null = null;
        let ambiguous: Person[] = [];
        if (known.length === 1) {
          await recordOnPerson(known[0], 'identifier', input, text, ids, now);
          // A question still open about this name is not settled by an address someone else could have written
          // (a From line can be forged): the person is only offered, and its tasks wait for the owner's answer
          if (byKey && ['watching', 'ask', 'asked'].includes(byKey.status) && !byKey.suggestedPersonId) {
            await db.peopleNames.put({ ...byKey, suggestedPersonId: known[0].id, lastAt: now });
          }
          return { kind: 'person', personId: known[0].id, via: 'identifier', added: false } as const;
        }
        if (known.length > 1) ambiguous = known;
        else if (key) {
          const found = await resolve(text, { workspaceId });
          if (found && 'person' in found) {
            // Anyone can write a display name: a name brings no address to a person, only the owner's answer does
            if (!bringsNew(found.person, ids, workspaceId)) {
              await recordOnPerson(found.person, found.via, input, text, ids, now);
              return { kind: 'person', personId: found.person.id, via: found.via, added: false } as const;
            }
            // The name matches, but the address is new to them: offered, never assumed
            suggested = found.person;
          } else if (found) {
            ambiguous = found.candidates;
          }
          // Nobody here by that name: someone of that name in another workspace is not offered either
        }
        return upsertCandidate(input, text, ids, { suggested, ambiguous }, byKey, now);
      });
    },

    get: (id: string) => db.people.get(id),
    candidate: (id: string) => db.peopleNames.get(id),

    /** Everyone, or the people of one workspace, by name. */
    async list(options: { workspaceId?: string | null } = {}): Promise<Person[]> {
      const all =
        options.workspaceId === undefined
          ? await db.people.toArray()
          : options.workspaceId === null
            ? (await db.people.toArray()).filter(person => person.workspaceIds.length === 0)
            : await db.people.where('workspaceIds').equals(options.workspaceId).toArray();
      return all.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** A person the owner names himself (the People page, `person_note`). */
    async create(
      fields: { name: string; workspaceId: string | null; about?: string; email?: string; alias?: string },
      now = Date.now(),
    ): Promise<Person> {
      let person = newPerson(fields.name, now);
      if (!person.nameKey) throw new Error('A person needs a name.');
      if (fields.workspaceId) person.workspaceIds = [fields.workspaceId];
      if (fields.about?.trim()) person.about = fields.about.trim().slice(0, 200);
      person = addIdentifiers(person, {
        emails: [cleanEmail(fields.email)].filter(Boolean) as string[],
        phones: [],
        handles: [],
      });
      if (fields.alias) person = addAliasTo(person, fields.alias, fields.workspaceId, 'avi');
      person.seen = [{ source: 'avi', workspaceId: fields.workspaceId, at: now }];
      await db.people.put(withKeys(person));
      return withKeys(person);
    },

    /** Saves another name a person goes by, for one workspace (or null: everywhere). */
    async addAlias(
      personId: string,
      text: string,
      workspaceId: string | null,
      from: PersonSource = 'avi',
      now = Date.now(),
    ): Promise<Person> {
      return tx(async () => {
        const person = await db.people.get(personId);
        if (!person) throw new Error('That person is no longer here.');
        const next = { ...addAliasTo(person, text, workspaceId, from), updatedAt: now };
        await db.people.put(withKeys(next));
        return withKeys(next);
      });
    },

    /** The owner's edits on the People page: name, role, and the lists he trimmed. */
    async edit(
      personId: string,
      changes: Partial<Pick<Person, 'name' | 'about' | 'aliases' | 'handles' | 'emails' | 'phones' | 'workspaceIds'>>,
      now = Date.now(),
    ): Promise<Person> {
      return tx(async () => {
        const person = await db.people.get(personId);
        if (!person) throw new Error('That person is no longer here.');
        const name = changes.name !== undefined ? cleanName(changes.name) : person.name;
        if (!nameKey(name)) throw new Error('A person needs a name.');
        const next = withKeys({
          ...person,
          ...changes,
          name,
          about: changes.about !== undefined ? changes.about.trim().slice(0, 200) || undefined : person.about,
          emails: (changes.emails ?? person.emails).map(cleanEmail).filter((email): email is string => !!email),
          phones: (changes.phones ?? person.phones).map(cleanPhone).filter((phone): phone is string => !!phone),
          updatedAt: now,
        });
        await db.people.put(next);
        return next;
      });
    },

    /**
     * Folds `dropId` into `keepId`: names, aliases, handles, addresses, workspaces and sightings move, and
     * every unsettled name that pointed at the dropped person points at the kept one. Tasks move through the
     * caller (the task board's `setOwner`), which is told both ids.
     */
    async merge(keepId: string, dropId: string, now = Date.now()): Promise<Person> {
      if (keepId === dropId) throw new Error('Pick two different people to merge.');
      return tx(async () => {
        const keep = await db.people.get(keepId);
        const drop = await db.people.get(dropId);
        if (!keep || !drop) throw new Error('One of those people is no longer here.');
        let next: Person = { ...keep };
        // The dropped name keeps its reach: its own workspaces, or everywhere only if it had none
        if (drop.nameKey !== keep.nameKey) {
          for (const target of drop.workspaceIds.length ? drop.workspaceIds : [null]) {
            next = addAliasTo(next, drop.name, target, 'avi');
          }
        }
        for (const alias of drop.aliases) next = addAliasTo(next, alias.text, alias.workspaceId, alias.from);
        let handles = next.handles;
        for (const handle of drop.handles) {
          if (
            !handles.some(other => handleKey(other) === handleKey(handle) && other.workspaceId === handle.workspaceId)
          ) {
            handles = [...handles, handle];
          }
        }
        const seen = [...next.seen];
        for (const entry of drop.seen) {
          const at = seen.findIndex(other => other.source === entry.source && other.workspaceId === entry.workspaceId);
          if (at === -1) seen.push(entry);
          else if (seen[at].at < entry.at) seen[at] = entry;
        }
        next = withKeys({
          ...next,
          handles,
          emails: drop.emails.reduce(addUnique, next.emails),
          phones: drop.phones.reduce(addUnique, next.phones),
          workspaceIds: drop.workspaceIds.reduce(addUnique, next.workspaceIds),
          seen: seen.sort((a, b) => b.at - a.at).slice(0, MAX_SEEN),
          about: next.about ?? drop.about,
          lastSeenAt: Math.max(next.lastSeenAt ?? 0, drop.lastSeenAt ?? 0) || undefined,
          createdAt: Math.min(keep.createdAt, drop.createdAt),
          updatedAt: now,
        });
        await db.people.put(next);
        await db.people.delete(dropId);
        await db.peopleNames
          .filter(
            candidate =>
              candidate.personId === dropId ||
              candidate.suggestedPersonId === dropId ||
              candidate.candidatePersonIds.includes(dropId),
          )
          .modify(candidate => {
            if (candidate.personId === dropId) candidate.personId = keepId;
            if (candidate.suggestedPersonId === dropId) candidate.suggestedPersonId = keepId;
            candidate.candidatePersonIds = [
              ...new Set(candidate.candidatePersonIds.map(id => (id === dropId ? keepId : id))),
            ];
          });
        return next;
      });
    },

    /** Removes a person. Names that were settled as them are unsettled again (and may be asked about). */
    async remove(personId: string): Promise<void> {
      await tx(async () => {
        await db.people.delete(personId);
        await db.peopleNames
          .filter(candidate => candidate.personId === personId || candidate.suggestedPersonId === personId)
          .modify(candidate => {
            if (candidate.personId === personId) {
              candidate.personId = null;
              candidate.status = 'watching';
              candidate.askedOn = null;
            }
            if (candidate.suggestedPersonId === personId) candidate.suggestedPersonId = null;
            candidate.candidatePersonIds = candidate.candidatePersonIds.filter(id => id !== personId);
          });
      });
    },

    /**
     * The owner's answer to a "Who's who" question. "Same" and "new" save every spelling as an alias for the
     * workspace it was seen in, and any address or handle; "not a person" stops the name being asked again.
     *
     * @returns the person, and the tasks that were waiting on the name
     */
    async answer(
      candidateId: string,
      answer: CandidateAnswer,
      now = Date.now(),
    ): Promise<{ personId: string | null; taskIds: string[]; created: boolean }> {
      return tx(async () => {
        const candidate = await db.peopleNames.get(candidateId);
        if (!candidate) throw new Error('That question is no longer open.');
        if (answer.kind === 'not_person') {
          await db.peopleNames.put({ ...candidate, status: 'not_person', personId: null, lastAt: now });
          return { personId: null, taskIds: [], created: false };
        }
        let person: Person | undefined;
        if (answer.kind === 'same') {
          person = await db.people.get(answer.personId);
          if (!person) throw new Error('That person is no longer here.');
        } else {
          person = newPerson(answer.name || candidate.text, now);
          if (!person.nameKey) throw new Error('A person needs a name.');
        }
        const spellings = [{ text: candidate.text, workspaceId: candidate.workspaceId }, ...candidate.otherTexts];
        // A name seen with no workspace (an inbox, an invite) is saved for the person's own workspaces
        const own = [...person.workspaceIds];
        for (const spelling of spellings) {
          for (const target of aliasWorkspaces(spelling.workspaceId, own)) {
            person = addAliasTo(person, spelling.text, target, 'avi');
          }
        }
        person = addIdentifiers(person, candidate);
        let seen = person.seen;
        for (const sighting of candidate.sightings) {
          seen = addSeen({ ...person, seen }, sighting.source, candidate.workspaceId, sighting.at);
        }
        const workspaceIds = spellings
          .map(spelling => spelling.workspaceId)
          .reduce<string[]>((list, id) => (id ? addUnique(list, id) : list), person.workspaceIds);
        const next = withKeys({
          ...person,
          seen,
          workspaceIds,
          lastSeenAt: Math.max(person.lastSeenAt ?? 0, candidate.lastAt),
          updatedAt: now,
        });
        await db.people.put(next);
        await db.peopleNames.put({ ...candidate, status: 'settled', personId: next.id, lastAt: now });
        return { personId: next.id, taskIds: candidate.taskIds, created: answer.kind === 'new' };
      });
    },

    /** Names not settled yet, most-seen first: the People page's "To sort" tab. */
    async unsettled(): Promise<NameCandidate[]> {
      const open = await db.peopleNames.where('status').anyOf(['watching', 'ask', 'asked']).toArray();
      return open.sort((a, b) => b.tasks - a.tasks || b.count - a.count || b.lastAt - a.lastAt);
    },

    /** Names ready to be asked and on no card yet, most-seen first; with `meetingId`, those seen in that call. */
    async readyToAsk(options: { meetingId?: string; limit?: number } = {}): Promise<NameCandidate[]> {
      const ready = options.meetingId
        ? (await db.peopleNames.where('meetingIds').equals(options.meetingId).toArray()).filter(
            candidate => candidate.status === 'ask',
          )
        : await db.peopleNames.where('status').equals('ask').toArray();
      return ready
        .sort((a, b) => b.tasks - a.tasks || b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, options.limit ?? 6);
    },

    /** Puts names on a card. */
    async markAsked(candidateIds: string[], cardId: string): Promise<void> {
      await db.peopleNames
        .where('id')
        .anyOf(candidateIds)
        .modify(candidate => {
          if (candidate.status === 'ask') {
            candidate.status = 'asked';
            candidate.askedOn = cardId;
          }
        });
    },

    /**
     * Puts the names ready to be asked on one card, in one transaction, so two cards made at once never share a
     * name. A name spelt the same as one already on the card waits for the next. With `once`, a card that already
     * has questions gets none.
     */
    async claim(
      cardId: string,
      options: { meetingId?: string; limit?: number; once?: boolean } = {},
    ): Promise<NameCandidate[]> {
      return tx(async () => {
        if (options.once && (await db.peopleNames.where('askedOn').equals(cardId).count()) > 0) return [];
        const limit = options.limit ?? 6;
        const ready = await store.readyToAsk({ meetingId: options.meetingId, limit: Number.MAX_SAFE_INTEGER });
        const keys = new Set<string>();
        const picked: NameCandidate[] = [];
        for (const candidate of ready) {
          const key = nameKey(candidate.text);
          if (keys.has(key)) continue;
          keys.add(key);
          picked.push(candidate);
          if (picked.length >= limit) break;
        }
        if (picked.length === 0) return [];
        await store.markAsked(
          picked.map(candidate => candidate.id),
          cardId,
        );
        return picked.map(candidate => ({ ...candidate, status: 'asked' as const, askedOn: cardId }));
      });
    },

    /** The questions on a card (answered ones included, so the card shows what was said). */
    onCard: (cardId: string) => db.peopleNames.where('askedOn').equals(cardId).toArray(),

    /**
     * The words the vocabulary should know (docs/pm-desk.md Part 4): the names and aliases of a workspace's
     * people, and the aliases saved for everywhere. `workspaceId` null gives everyone's names and global aliases.
     */
    async vocabularySeeds(workspaceId: string | null): Promise<string[]> {
      const people = workspaceId === null ? await db.people.toArray() : await store.list({ workspaceId });
      const words = new Set<string>();
      for (const person of people) {
        words.add(person.name);
        for (const alias of person.aliases) {
          if (alias.workspaceId === null || alias.workspaceId === workspaceId) words.add(alias.text);
        }
      }
      return [...words];
    },
  };
  return store;
}

export type PeopleStore = ReturnType<typeof createPeopleStore>;

export const peopleStore = createPeopleStore();

export type { PersonAlias };
