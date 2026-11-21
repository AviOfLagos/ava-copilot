/**
 * People: who is who, under every name they use, learned per workspace from every place Ava already reads
 * (docs/pm-desk.md, Part 5). Everything here stays on this computer (rule 5): names, aliases, emails and
 * phone numbers leave only inside a prompt that needs them, a message to the owner himself, or an export he
 * starts.
 */

// Where a name was seen
export type PersonSource =
  'meet' | 'spoken' | 'calendar' | 'whatsapp' | 'slack' | 'gmail' | 'github' | 'chat' | 'note' | 'task' | 'avi';

export const PERSON_SOURCES: PersonSource[] = [
  'meet',
  'spoken',
  'calendar',
  'whatsapp',
  'slack',
  'gmail',
  'github',
  'chat',
  'note',
  'task',
  'avi',
];

export type HandleKind = 'slack' | 'github' | 'whatsapp' | 'x' | 'linkedin';

export interface PersonAlias {
  text: string;
  // null means everywhere
  workspaceId: string | null;
  from: PersonSource;
}

// How someone appears in a tool: a user id, a login, a number
export interface PersonHandle {
  kind: HandleKind;
  value: string;
  // null means everywhere
  workspaceId: string | null;
}

export interface PersonSighting {
  source: PersonSource;
  workspaceId: string | null;
  at: number;
}

export interface Person {
  // 'per_' + 10 random base32 characters
  id: string;
  // What the owner calls them
  name: string;
  aliases: PersonAlias[];
  handles: PersonHandle[];
  // A person's own addresses: the same in every workspace
  emails: string[];
  phones: string[];
  workspaceIds: string[];
  // The latest sighting per source and workspace, at most 20
  seen: PersonSighting[];
  // Role, one line
  about?: string;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
  // Index keys, kept in step by the store (./store.ts): never written by hand
  nameKey: string;
  // `${workspaceId ?? '*'}|${normalized alias}`
  aliasKeys: string[];
  // `${kind}:${value}`
  handleKeys: string[];
}

/** Where an unsettled name was seen, in words for the "Who's who" card: "sent a message in Slack". */
export interface NameSighting {
  source: PersonSource;
  at: number;
  context?: string;
  // The thing it was seen in (a meeting id, an Inbox item id), so one thing never counts twice
  ref?: string;
}

/**
 * A name `observe` could not settle: unknown, or matching more than one person, or matching a person by name
 * only while carrying an address that person does not have yet. Kept per workspace. One bare sighting is only
 * watched; it is asked about once seen twice, once with a task, or once seen on a call with the owner.
 */
export interface NameCandidate {
  // 'nam_' + 10 random base32 characters
  id: string;
  // `${workspaceId ?? '*'}|${normalized text}`: one candidate per name per workspace
  key: string;
  text: string;
  // Other spellings that turned out to be the same candidate, through a shared address or handle
  otherTexts: { text: string; workspaceId: string | null }[];
  workspaceId: string | null;
  emails: string[];
  phones: string[];
  handles: PersonHandle[];
  handleKeys: string[];
  // The latest 20
  sightings: NameSighting[];
  // Distinct things it was seen in
  count: number;
  // Tasks waiting on this name (the task board links them when the answer comes)
  taskIds: string[];
  tasks: number;
  // Calls it was seen in, for the card after each call
  meetingIds: string[];
  // The person code thinks it may be, to offer as "Is this X?"; never acted on without an answer
  suggestedPersonId: string | null;
  // When the name matched several people
  candidatePersonIds: string[];
  // watching: seen, not asked yet · ask: ready for a card · asked: on a card · settled: answered with a
  // person · not_person: the owner said it is not a person; never asked again
  status: 'watching' | 'ask' | 'asked' | 'settled' | 'not_person';
  // The card it is on: `meeting:<id>` or `daily:<yyyy-mm-dd>`
  askedOn: string | null;
  personId: string | null;
  firstAt: number;
  lastAt: number;
}

export interface ObserveInput {
  // The name as seen: "dev.kunle", "Kunle A.", "Ada"
  text: string;
  source: PersonSource;
  // The workspace of the thing it was seen in, or null
  workspaceId: string | null;
  email?: string | null;
  phone?: string | null;
  handle?: { kind: HandleKind; value: string } | null;
  // One line for the card: "sent a message in #launch", "given 2 tasks"
  context?: string;
  // The thing it was seen in, so the same thing seen again does not count as a second sighting
  ref?: string;
  // A task is attached to this name: it is asked about at once
  taskId?: string;
  // Seen in this call
  meetingId?: string;
  // The owner's own word, or code that corroborated the link (a calendar attendee who is a roster name on the
  // same call): a new email, phone or handle is added to the person the name resolves to
  trusted?: boolean;
}

export type ObserveResult =
  | { kind: 'person'; personId: string; via: ResolveVia; added: boolean }
  | { kind: 'candidate'; candidateId: string; asking: boolean }
  | { kind: 'ignored' }
  | { kind: 'skipped' };

export type ResolveVia = 'identifier' | 'name' | 'alias' | 'alias_everywhere' | 'first_name';

export type ResolveResult = { person: Person; via: ResolveVia } | { candidates: Person[] } | null;

export type CandidateAnswer =
  { kind: 'same'; personId: string } | { kind: 'new'; name: string } | { kind: 'not_person' };
