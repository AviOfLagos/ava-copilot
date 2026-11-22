# The PM desk: tasks, people and follow-ups that Ava keeps for you

Logged 2026-11-21 from Avi's brief. It began as a spec and is now mostly built. **Status on 2026-11-22**
(what a reader of the site sees is in [CHANGELOG.md](../CHANGELOG.md)):

| Part | State | Pull requests or issue |
|---|---|---|
| 1 Typing box | Built | #116 |
| 2 Task board | Built | #121, #122, #123 |
| 3 Workspaces in one click, by voice, sorted | Built | #126 |
| 4 Vocabulary | Built | #117 |
| 5 People | Built | #118, #119, #120 |
| 6 "Ava, note a task for…" on a call | In progress; not available | issue #108 |
| 7 Screen recording for a task | Built (Drive tested only against a fake endpoint) | #127 |
| 8 Tasks on WhatsApp | Built | #124, #125 |
| 9 Follow-ups, who to chase | In progress; not available | issue #111 |

The text below is the original spec; where the code differs, the pull request says so.
It was reviewed once against the brief and the code, and the findings are
folded in. Each numbered part maps to one GitHub issue (see "Build order"). Every part
names the model level that should build it: the spec was drafted on the
largest model so the building does not have to be.

Tracking: epic #112 (issues #103 to #111, in part order).

## What Avi asked for, in one paragraph

A product owner should not chase people by hand. On a call Avi says "Ava,
note a task for Ada" and the task exists. After the call each person's tasks
are written up, with a screen recording when one helps, and Avi gets them on
WhatsApp ready to pass on. Ava knows who the people are, including the
different names they go by. Every task has a real done state that Avi can
tick in the panel or from WhatsApp. Ava reminds him who to follow up with and
drafts the message. Around that: the typing box gets more room, a workspace
can be created in one click or by voice and things move into it, and words
Ava keeps mishearing ("Illum" for "Ellum") are corrected everywhere speech
becomes text.

## What exists today (checked in the code at `b47e846`, 2026-11-21)

| Area | Today | Where |
|---|---|---|
| Typing box | Textarea shares one row with the sparkle and the buttons. It grows to 132 px (about five lines), then scrolls. No expand control. `ChatInput.tsx` is dead code. | `src/side-panel/components/Composer.tsx:57,101-106,366-400` |
| Checkboxes in the brief | Drawn by Streamdown as `<input type="checkbox" disabled>`. They do nothing. | `src/side-panel/components/ai/message.tsx:70-87` |
| Where "open actions" come from | Three places, none with an id or a done state: meeting `actionItems {owner, task, due}`, knowledge-graph `action` nodes, and "Next actions" strings in workspace summaries. The brief prints two lists that can repeat each other. "Open" means "seen in the last 7 days". The due date is dropped when a meeting item enters the graph. | `src/storage/lib/threads/db.ts:155-169,313-326`, `src/background/graph/extract.ts:66-74,145-156`, `src/background/history/rollup.ts:30-41,103-113`, `src/background/brief/brief.ts:306-329` |
| Task store | None, in the extension or in Ava Brain. | — |
| Workspaces | `workspaceStore.save` is the only writer; the settings screen and the Suture product seed are its only callers. Items are placed by keyword rules (`routeWorkspace`), never by a model; two matches place nothing. "No workspace" is a null `workspaceId`. No agent, voice or WhatsApp way to create one. | `src/storage/lib/workspaces/workspaces.ts:137-235`, `src/background/threads/manager.ts:263-288` |
| Speech to text | One function for dictation, WhatsApp voice notes and video attachments (`transcribeSpeech`), Gemini first when a key is set, else local Moonshine, Whisper or Vosk. Meetings and ambient have their own paths. No vocabulary, no correction, no hint beyond a language sentence. | `src/background/voice/dictation.ts:101-132`, `src/offscreen/stt/*`, `src/background/meetings/manager.ts:710-787` |
| Known bug | Video attachments call `transcribe(wav, 'audio/wav')`: the second argument is the thread id, so the chat's voice settings are ignored. | `src/background/index.ts:332,409` |
| Meet notes | Tab audio first (needs a toolbar click or Alt+Shift+M on the tab), live captions as the fallback. Captions carry Meet's display name per line; audio gives "Speaker 1" or nothing. The participant list is never read (a deliberate choice, noted in the code). `participants` in the note is the model's guess. | `src/background/meetings/manager.ts:135-183,374-395,960-973`, `src/background/meetings/captions.ts:41-60,179-333` |
| Spoken commands in a call | None. "Hey Ava" exists only as the general wake word on Avi's microphone, off by default. | `src/background/voice/wake.ts`, `src/offscreen/wake.ts` |
| People | No store. Graph `person` nodes hold a name per workspace and nothing else. Calendar attendees are not read. `UserFact.category` includes `'person'`. | `src/storage/lib/threads/db.ts:300-327`, `src/background/calendar/ics.ts`, `src/storage/lib/identity/types.ts:24` |
| WhatsApp | Ava Brain messages the owner only, enforced in the companion. Inbound text is matched for three whole-message commands without a model. Quoted replies and message ids are used. Ava sends reactions, but a reaction Avi sends is dropped in Ava Brain (`baileys.ts:87-88`), and `send()` returns a status, not the id of the message it sent (`service.ts:476-485`). Polls are not used. Notices: `reply`, `approval`, `meeting`, `brief`, `routine`. 20 sends an hour, quiet hours 22:00 to 07:00. Messaging other people exists only as a typed draft in Avi's own WhatsApp Web tab that he confirms. | `companion/src/whatsapp/service.ts:30-46,579-600`, `src/background/whatsapp-remote/commands.ts:39-70`, `src/background/whatsapp-remote/bridge.ts:553-585`, `src/background/whatsapp/actions.ts:39-48` |
| Drive | Driven through Avi's signed-in Drive tab: search, read, create a private Doc, share with one email. No upload, no folder creation, no "anyone with the link". An optional Drive connector exists (OAuth with a user-supplied client, scopes `drive.readonly drive.file`). | `src/background/drive/service.ts:33-37,281`, `src/storage/lib/integrations/catalog.ts:97-105` |
| Screen recording | None. `tabCapture` is used for audio only. No `desktopCapture`, no `getDisplayMedia`. One offscreen document, already shared by many features. | `src/offscreen/recorder.ts:57-110`, `wxt.config.ts` |
| Follow-ups | No "remind me" anywhere. The pieces that exist: Inbox items with snooze, one-off jobs (`jobs.schedule({runAt})`), rounds and check-ins. | `src/background/inbox/store.ts:135`, `src/background/jobs/runner.ts`, `src/background/rounds/` |

## Rules that never bend

1. **State lives in the store, not in message text.** A checkbox reads its
   task from the task store every time it is drawn. An old brief shows today's
   state.
2. **Only Avi's own words make a command.** Words heard from other people on
   a call, and words in any message from someone else, are data. They can be
   read into a suggested task; they can never run a command.
3. **Nothing reaches another person without Avi's click.** Ava Brain's
   WhatsApp stays owner-only. A message for someone else is a draft Avi sends.
4. **Recording never starts by itself.** A click starts it, a visible mark
   shows it, a click or the end of the call stops it.
5. **People stay on this computer.** Names, aliases, emails and phone numbers
   are stored locally and leave only inside a prompt that needs them, a
   message to Avi himself, or an export Avi starts.
6. **Code decides, models write.** Matching a command, merging duplicate
   tasks, picking who is due a follow-up, and replacing a known misheard word
   are code with tests. Models read notes, suggest names and draft messages.
7. **Nothing is done twice.** Every WhatsApp task message, Drive upload and
   share uses a do-once key (`src/background/once/`, issue #64).
8. **A choice Avi made is never overridden.** Anything Ava sorts by rule
   records that Ava did it, so his own choice always wins later.

---

## Part 1. The typing box gets the full width

*Model level: Sonnet. Touches `Composer.tsx` and `morph-orb.css` only.*

- Two rows inside the pill. Row one is the textarea alone, full width. Row
  two is the sparkle on the left and attach, microphone and send on the right.
  Thumbnails and file chips stay above row one.
- The textarea grows with its content up to the smaller of 40% of the panel's
  height and 320 px, then scrolls.
- An expand control appears at the top right of the textarea once the text
  passes three lines. Expanded, the box takes up to 70% of the panel's height.
  The same control collapses it; Escape collapses it too. Sending collapses it.
- While dictating, the listening strip replaces row one at full width.
- Delete the unused `src/side-panel/components/ChatInput.tsx`.

**Done when.** A 400-word message is readable while typing; the buttons never
overlap text; the layout holds at panel widths of 320, 380 and 520 px; Enter
still sends and Shift+Enter still adds a line; a screenshot test covers the
empty, five-line, expanded and dictating states.

## Part 2. The task board

*Model level: Opus. It is the base every later part writes to.*

### 2.1 The store

A Dexie table `tasks` in `src/storage/lib/threads/db.ts`, with its own
`version()` step, and a small API in `src/storage/lib/tasks/`.

```ts
type TaskStatus = 'open' | 'done' | 'dropped';

interface Task {
  id: string;                 // 'tsk_' + 10 random base32 chars
  title: string;              // what is to be done, one line
  detail?: string;            // more words, if the source had them
  workspaceId: string | null;
  workspaceSetBy: 'avi' | 'rule' | 'ava';
  ownerId: string | null;     // a Person id (Part 5); null until resolved
  ownerName: string | null;   // the name as it was said or written
  status: TaskStatus;
  doneAt?: number;
  doneBy?: 'avi' | 'ava';     // 'ava' only when a source says it was done
  due?: string;               // ISO date, when one could be worked out
  dueText?: string;           // the words used ("by Friday")
  source: {
    kind: 'meeting' | 'chat' | 'note' | 'voice' | 'whatsapp' | 'manual' | 'summary';
    id?: string;              // meeting id, thread id, knowledge item id
    quote?: string;           // the sentence it came from, at most 300 chars
  };
  seenIn: string[];           // every source item id that mentioned it
  links: { label: string; url: string }[];   // a recording, a doc
  followUp?: { askedAt?: number; nextAt?: number; count: number };
  externalRefs: { system: string; id: string }[];  // for Sheets/Notion/Linear later
  createdAt: number;
  updatedAt: number;
}
```

Indexes: `status`, `workspaceId`, `ownerId`, `[status+workspaceId]`,
`updatedAt`.

API: `tasks.add`, `tasks.update`, `tasks.setStatus(id, status, by)`,
`tasks.list({status, workspaceId, ownerId, dueBefore})`, `tasks.get`,
`tasks.merge(keepId, dropId)`, `tasks.move(ids, workspaceId, by)`, and
`tasks.onChange(listener)` so open views redraw.

### 2.2 One task, however many times it was mentioned

Every source that produced an "action" today writes to the store through one
function, `recordTask(candidate)`:

1. Meeting notes: each `actionItems` entry, keeping `due` (today it is lost).
2. Knowledge-graph readings: each `action` reading in `sliceFrom`.
3. Workspace summaries stop inventing "Next actions" as free strings. They
   list tasks from the store instead.

`recordTask` finds an existing task before adding one. Two mentions are the
same task when all of these hold:

- same workspace, and the same owner or one side without an owner;
- the new mention is within 14 days of the task's `updatedAt`;
- the titles match: either equal after normalising (lower case, punctuation
  and extra spaces removed), or a Jaccard overlap of at least 0.85 between
  their word sets after dropping this stop list: `the a an to of for and on
  in with please`;
- every number in one title is in the other ("PR 12" and "PR 13" stay apart).

A match adds the source to `seenIn` and fills gaps (owner, due). It never
reopens a task Avi closed. No model is involved.

Graph `action` nodes stay, for the graph view, and carry the task id.

**Backfill, once.** On upgrade, tasks are made from meeting action items and
graph actions of the last 30 days, all open. The Tasks page offers "Close
everything older than two weeks" so the start is not a wall.

### 2.3 Checkboxes that work

- Wherever a task is written into markdown it ends with a marker Ava's
  renderer understands, for example `- [ ] Send the login to Ada ^tsk_ab12cd34ef`.
  `MessageResponse` (`src/side-panel/components/ai/message.tsx`) draws a
  marked item as a live `TaskCheckbox`: its state comes from the store,
  a click sets done, a second click reopens. The marker itself is not shown.
- A marker is live only when code vouches for it: the message carries a
  `taskIds` list written by the code that built it (the brief, the meeting
  note, the after-call list), the id is on that list, and the task exists. A
  marker that a model wrote into a reply is shown as plain text and gets no
  working box.
- An unmarked `- [ ]` line stays a plain, disabled box, as now.
- The same component is used in the brief, the meeting note, the workspace
  summary view (`WorkspaceSummaryView.tsx`, which prints "☐" text today) and
  the Tasks page.
- A done task shows struck through with who closed it and when on hover.
- The text sent to WhatsApp, to voice and to exports strips the marker.

### 2.4 The Tasks page

A page in the panel: tasks grouped by workspace, or by person, with a filter
for open, done and dropped. Each row: checkbox, title, owner, due, where it
came from (a link to the meeting or chat), and a menu to edit, move to a
workspace, give to a person, drop, or merge with another. "Add task" at the
top. Empty states say what to do, for example "No open tasks. Say 'Ava, note a
task for…' on a call, or add one here."

### 2.5 The brief

The two overlapping lists become one: under each workspace, up to five open
tasks, oldest due first, then oldest. "No workspace" lists its tasks the same
way, with the button from Part 3. The spoken brief (`voice/prompt.ts:130`)
reads from the same list.

### 2.6 Tools

Agent actions and voice tools, all plain code: `task_add`, `task_done`,
`task_reopen`, `task_list`, `task_assign`, `task_move`. "Ava, mark the login
task done" works by voice; when more than one task matches, Ava asks which.

**Done when.** A box ticked in last Tuesday's brief shows ticked in today's
brief, on the Tasks page and in the meeting note; unticking reopens it
everywhere; the same task mentioned in two meetings appears once; a meeting
item with "by Friday" keeps its date; the brief has one list per workspace;
tests cover dedupe, backfill, the renderer and the marker being stripped for
WhatsApp.

## Part 3. Workspaces in one click, by voice, and sorted for you

*Model level: Sonnet. Needs Part 2 merged.*

- **One click.** The "No workspace" group in the brief and on the Tasks page
  has a button, "Make a workspace for these". It opens a small sheet: a name
  and keywords suggested by the light model from the items in the group,
  editable, and a tick list of the items that will move (all ticked). Saving
  creates the workspace and moves the ticked tasks, chats, meetings and
  knowledge items. One undo is offered for 30 seconds and in the Inbox.
- **By voice and by chat.** `workspace_create` (agent action and voice tool):
  "Ava, create a workspace called Lead Engine." It is created at once, Ava
  says so, and the same undo applies. A name that already exists is not
  created twice; Ava says it exists. If things in "No workspace" match the
  new name or its words, the panel then shows the same sheet so they can be
  moved in one confirm.
- **Sorted by rule.** When two or more items in "No workspace" match exactly
  one workspace by its name, keywords, Google account or people (Part 5),
  Ava moves them, marks them `workspaceSetBy: 'rule'`, and the next brief says
  "Moved 3 things to Tech Ember Fest" with an undo. When the only evidence is
  a model's guess, Ava does not move anything: she offers it in the Inbox,
  "These 3 look like Tech Ember Fest. Move them?" Anything Avi placed himself
  (`workspaceSetBy: 'avi'`) is never moved.
- **Things in the wrong workspace.** An item that a rule or Ava placed, and
  that now matches exactly one other workspace and not its own, is offered in
  the Inbox the same way. It is never moved without a yes.
- Meetings gain one more routing rule, after the typed topic and before the
  Google account: when most known participants belong to one workspace.

**Done when.** Creating a workspace from the "No workspace" group takes one
click and one confirm; items move and the undo restores them; the voice
command works with the microphone off-screen test harness; a rule move is
reported once and can be undone; an item Avi placed stays put.

## Part 4. Vocabulary: words Ava mishears, fixed everywhere

*Model level: Sonnet. Independent of Part 2.*

### 4.1 The store

```ts
interface VocabEntry {
  id: string;
  write: string;              // the right spelling: "Ellum"
  heardAs: string[];          // what the recogniser writes: "Illum", "Elum", "L.M."
  kind: 'name' | 'product' | 'person' | 'term';
  workspaceId: string | null; // null means everywhere
  learnedFrom: 'avi' | 'correction' | 'seed';
  uses: number;
  createdAt: number;
}
```

A Dexie table `vocabulary`. Seeded, and kept in step, from workspace names,
product names (Part 6 of the growth spec) and people's names and aliases
(Part 5 here). Avi's entries win over seeds.

A `heardAs` phrase must have at least two letters once punctuation is
removed, and is matched as whole words only ("L.M." must never rewrite "LM
Studio"). A `heardAs` that is itself an ordinary English word is accepted
only when Avi typed it (`learnedFrom: 'avi'`).

### 4.2 The engine

`correctTranscript(text, {workspaceId}) → {text, changes[], unsure[]}` in
`src/background/voice/vocabulary/`, plain code:

1. **Known mishearings.** Each `heardAs` phrase, matched on word boundaries,
   any letter case, across one to three words, becomes `write`.
2. **Near misses.** A word or word pair of four letters or more is a
   candidate when it is close to exactly one in-scope entry's `write`: edit
   distance at most 1 for words up to five letters and at most 2 for longer
   ones, or the same Double Metaphone code. Then:
   - if the heard word is a real English word, it is **not** changed; it goes
     in `unsure` ("ilium" stays "ilium" even with "Ellum" in the vocabulary);
   - if it is close to two entries, it is not changed; it goes in `unsure`;
   - otherwise it is replaced.

   "A real English word" means it is in a bundled list of about 80,000
   English words (SCOWL or similar; the PR records the list's source and
   licence). Double Metaphone is implemented in the repo or taken from a
   package with no dependencies; the PR says which.
3. Every change is recorded as `{from, to, at}` so the user can see and undo
   it.

For a dictation of more than 40 words with `unsure` items, one light-model
call may settle them. It may only pick from the entries listed for each
`unsure` item or answer "leave it". It never rewrites the text.

### 4.3 Where it runs

One call at each place speech becomes final text: `transcribeSpeech`
(dictation, WhatsApp voice notes, video attachments), the voice conversation,
meeting segments as they are stored, and the ambient scribe. Meeting segments
keep the original in `textRaw`.

The entries are also given to the recogniser as a hint where it accepts one:
appended to the Gemini prompt beside `listeningHint`, and passed as Whisper's
prompt if transformers.js exposes it (check; if not, say so in the PR).

Fix the video-attachment bug in the same PR (`index.ts:332,409`).

### 4.4 Learning

- **From a correction.** When dictated text is edited before sending and the
  edit replaces one word or short phrase with another, the composer shows a
  quiet chip: "Always write 'Ellum' for 'Illum'?" One tap saves it. The same
  correction made twice without tapping saves it anyway and says so.
- **By saying it.** "Ava, it's spelled E-L-L-U-M" or "Ava, when you hear
  Illum, write Ellum" (`vocab_add`, voice tool and agent action).
- **By hand.** Settings › Voice › Vocabulary: a list to add, edit and delete,
  showing how often each entry fired.
- Corrected words are underlined faintly in the composer for a few seconds;
  clicking one undoes that change and offers "Never change this word".
- An `unsure` word in the composer gets a quiet chip, "Did you mean Ellum?";
  it is never changed without the tap.

The engine, the store, the settings screen and the non-composer call sites
can be built at once. The composer chip and underline are built after Part 1
has merged, because both parts edit `Composer.tsx`.

**Done when.** With a global "Ellum" entry whose `heardAs` includes "Illum":
a dictation, a WhatsApp voice note and a meeting transcript that the
recogniser wrote as "Illum AI" all read "Ellum AI"; "Elum" (not a word, one
letter off) is corrected by the near-miss stage; "ilium" in a sentence about
anatomy is left alone and offered as a chip; "LM Studio" is untouched; a
correction made in the composer is offered as a rule; tests cover each stage
with at least 30 real mishearing pairs and 30 sentences that must not change,
and no test relies on a live model.

## Part 5. People: who is who, under every name they use

*Model level: Opus. Independent of Part 2 except for the owner link.*

People are learned per workspace from every place Ava already reads, not
from Meet alone: calls, calendar invites, WhatsApp, Slack, Gmail, GitHub,
chats, notes and tasks. Each place adds to the same person, and what is
learned in one place is used in all the others. Avi's correction (2026-11-21):
"Everything is interwoven, the system needs to learn."

### 5.1 The store

```ts
type PersonSource =
  | 'meet' | 'spoken' | 'calendar' | 'whatsapp' | 'slack' | 'gmail'
  | 'github' | 'chat' | 'note' | 'task' | 'avi';

interface Person {
  id: string;                  // 'per_' + 10 random base32 chars
  name: string;                // what Avi calls them
  aliases: {
    text: string;
    workspaceId: string | null;   // null means everywhere
    from: PersonSource;
  }[];
  handles: {                   // how they appear in a tool
    kind: 'slack' | 'github' | 'whatsapp' | 'x' | 'linkedin';
    value: string;             // a user id, a login, a number
    workspaceId: string | null;
  }[];
  emails: string[];            // a person's own addresses: the same in every workspace
  phones: string[];
  workspaceIds: string[];
  seen: { source: PersonSource; workspaceId: string | null; at: number }[];  // latest per source, at most 20
  about?: string;              // role, one line
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

A Dexie table `people`, with its own `version()` step, API in
`src/storage/lib/people/`: `people.resolve(text, {workspaceId}) →
{person} | {candidates[]} | null`, `people.addAlias`, `people.merge`,
`people.list`. Resolving tries, in order: an exact name; an alias whose
`workspaceId` is this workspace; an alias marked for everywhere; a unique
first-name match among people in this workspace; then nothing. An alias
saved for one workspace never resolves in another.

Graph `person` nodes carry the person id once one is known.

### 5.2 One way in, from everywhere

Every place that meets a name calls one function:

```ts
people.observe({
  text,            // the name as seen: "dev.kunle", "Kunle A.", "Ada"
  source,          // PersonSource
  workspaceId,     // the workspace of the thing it was seen in, or null
  email?, phone?, handle?,   // when the source gives one
  context?,        // one line: "sent a message in #launch", "given 2 tasks"
})
```

`observe` is plain code. It resolves the name (5.1). If it finds one person,
it records the sighting, adds any new email, phone or handle, adds the
workspace to `workspaceIds`, and adds the text as an alias for that workspace
when it is new. An email, phone or handle that already belongs to a person
identifies them whatever name was used; that is how "dev.kunle" on Meet and
"Kunle A." in Gmail become one person without asking. If it finds nobody, or
more than one, the name goes to "Who's who" (5.4). `observe` never creates a
person from a name alone: one bare sighting of an unknown name is kept as a
candidate and only becomes a question after it is seen twice, or once with a
task attached.

| Where | What is observed | Hook |
|---|---|---|
| Google Meet | Roster names, caption speakers (5.3) | `meetings/captions.ts`, `meetings/manager.ts` |
| Words in a call | Owners of action items, people addressed, updates (Part 9) | `meetings/notes.ts` after the note is written |
| Calendar | `ATTENDEE` and `ORGANIZER` names with emails | `calendar/ics.ts`, the Mac calendar reader |
| WhatsApp | The chat name and number of a chat Avi drafts into or reads in his WhatsApp Web tab; names Avi writes to Ava ("ada says…") | `whatsapp/actions.ts`, `whatsapp-remote/bridge.ts` |
| Slack | Sender names and user ids from the Slack watcher | `inbox/watchers/` |
| Gmail | Sender and recipient names with addresses from the Gmail watcher | `inbox/watchers/` |
| GitHub | Logins of authors and assignees on issues and PRs Ava reads in a workspace's repos | the GitHub connector results |
| Chats, notes, AI sessions | `person` readings from the knowledge graph | `graph/builder.ts` |
| Tasks | Owner names (Part 2) | `recordTask` |
| Avi | Anything he types or says about a person, and every "Who's who" answer | People page, voice tool `person_note` |

Only names from Avi's own accounts and tools are observed. Ava does not look
people up on the web, and does not read a tool she was not already reading.

What is learned flows back out: names and aliases seed the vocabulary
(Part 4), so a name Ava mishears is corrected; people who belong to one
workspace help place meetings and items in it (Part 3); a resolved owner
links tasks (Part 2), follow-ups and drafts (Part 9) to the right person and
the right chat.

### 5.3 Names from Google Meet

- **Who is on the call.** Read the participant list from Meet's page, in
  `captions.ts` beside `CALL_DOM`: the tile labels always, and the People
  panel only while Avi has it open. Ava never clicks anything in Meet to get
  names. Display names are stored on the meeting record as `roster`. This reverses the
  earlier choice not to read names; rule 5 is what makes that acceptable, and
  the comment at `manager.ts:960-973` is updated to say so.
- **Who said what.** Captions already carry the speaker's display name. When
  notes are taken from audio, the caption watcher runs alongside and each
  audio segment takes the speaker whose caption lines overlap it in time. A
  segment with no overlap keeps "Speaker n". This is code, not a model.
- **Emails.** Read `ATTENDEE` and `ORGANIZER` from calendar invites
  (`calendar/ics.ts`, and the Mac calendar reader in Ava Brain) and keep them
  on the event. When a meeting matches an event, an attendee whose name
  matches a roster name gives that person an email. The invite-file path
  works today; the Mac calendar path waits on issue #32 (it has answered 403
  since 26 October).

### 5.4 "Who's who": the questions Ava asks

Names that `observe` could not settle are asked about, in two places.

**After a call.** When notes are written, Ava compares three sets: roster
names, speaker names, and names used in speech (owners of action items,
people addressed). Anything unresolved goes on one card in the meeting's
chat and the Inbox:

> I heard some names I am not sure of.
> "Ada" was given 2 tasks. Is that **Adaeze O.** from the call? [Yes] [Someone else] [New person]
> **dev.kunle** was on the call. What do you call them? [Kunle] [type a name]

**Once a day, for everything else.** Unsettled names from Slack, Gmail,
WhatsApp, GitHub, chats and tasks are gathered into one Inbox card a day,
most-seen first, each with where it was seen ("sent 4 messages in #launch",
"assigned 2 issues"). When Ava has a likely match she offers it: "Is
**kunle-dev** on GitHub the same person as **Kunle A.**?"

Each answer saves an alias, handle or email for that workspace and is never
asked again; "Not a person" stops a name being asked about. A card has at
most six questions; the rest wait for the People page. Tasks, updates and
sightings that were waiting on a name are linked when the answer comes.

### 5.5 The People page

People by workspace: name, aliases, handles, email, where they were last
seen, open tasks. Edit, merge two people, remove. A "To sort" tab lists the
unsettled names. A person's page shows their status (Part 9) and every place
they have been seen.

**Done when.** After a Meet call taken from audio, at least the lines that
had captions carry real names; a second call with the same people asks no
questions; "Ada" resolves to the right person in that workspace and to
nobody in another; a Gmail sender whose address matches a calendar attendee
is the same person with no question asked; a Slack name seen twice appears
on the daily card with where it was seen, and the answer is remembered; a
bare name seen once creates no person and no question; a new person's name
is in the vocabulary seeds; merging two people moves their tasks, aliases
and handles; tests use saved page fixtures for Meet, Slack and Gmail, and no
test reads a live call or a live inbox.

## Part 6. "Ava, note a task for Ada" during a call

*Model level: Opus. Needs Parts 2 and 5; uses Part 4 for names.*

- **Hearing it.** While notes are running, Avi's own speech is checked for a
  command, in code, with no model:
  `(hey)? ava[,]? (please)? (note|add|log|create) (a)? task for <name>[:,]? <words>`,
  including the sound-alikes of "Ava" already in `src/offscreen/stt/addressed.ts`.
- **Whose speech counts.** Only Avi's (rule 2), and it is decided like this:
  - *With captions on:* a caption line counts when Meet's page marks it as
    the local user's own line (the self marker in the page structure, such as
    `[data-self-name]` in `CALL_DOM`). It is never decided by comparing a
    name string: Meet labels your own lines "You" in the interface language,
    and any guest can call themselves "You" or "Avi".
  - *With audio only:* the meeting recorder mixes the microphone into the tab
    sound, so there is nothing separate to listen to. The command needs its
    own microphone stream with echo cancellation and the local recogniser. A
    match is refused when the same words appear in another speaker's caption
    within three seconds either side, because loudspeakers leak the call into
    the microphone.
  - *With neither signal* (audio only, captions unavailable, no separate
    microphone): spoken commands are off for that call and the panel says so.
  The PR states which signal each path used and includes tests where a guest
  named "You" and a guest named "Avi" say the phrase and nothing happens.
- **Timing.** Meet keeps rewriting a caption line while someone speaks. A
  line is matched once, after it has stood unchanged for 1.5 seconds.
- **Drafting it.** The task is stored the moment the command is matched,
  with the owner resolved through `people.resolve`; that is what must happen
  within five seconds. For the next two minutes it stays open for additions:
  Avi's further sentences that start with "also", "and", "add to that" or
  "Ava," are added to it. It closes after a four-second pause following any
  other sentence, or when Avi says "Ava, note a task for…" again, which
  starts a new task rather than extending the old one. An unresolved name is
  kept as said and asked about after the call (Part 5.4).
- **Showing it.** No sound in the call. With the panel open, it shows a small
  card, "Task for Ada: …", with Edit and Discard, and "Record the screen for
  this?" with Yes and No (Part 7). The click on Yes is what allows the
  recording, so the offer exists only while the panel is open; Chrome will
  not open the panel without a click. With the panel closed, the task is
  still stored and recording is offered from the after-call list instead.
- **After the call.** The meeting's chat gets "Tasks from this call", grouped
  by person, each task editable, each recording playable, with one button:
  "Looks right". Until that click the tasks are in the store as open, nothing
  is sent, and no recording has a share link.
- **Passing them on.** After "Looks right", Avi gets one WhatsApp message per
  person (Part 8) with that person's tasks and any recording link, written so
  it can be forwarded as it is. Each also has "Draft a message to Ada", which
  types the message into that person's chat in Avi's WhatsApp Web tab and
  stops (the existing `whatsapp_draft_reply`); he presses send.

**Done when.** Saying the phrase on a test call creates one task for the
right person within five seconds; the same phrase from another speaker, from
a guest named "You" and from a guest named "Avi" creates none; a caption line
that Meet rewrites three times makes one task, not three; a follow-on
sentence extends the task and a second command starts a new one; with the
panel closed the task is still stored; the after-call list can be edited
before anything is sent; tests replay caption and audio fixtures.

## Part 7. A screen recording for a task, with a link to share

*Model level: Opus. Independent to build; Part 6 calls it.*

- **Starting.** Only from a click in the panel: the card in Part 6, or
  "Record screen" on a task. `getDisplayMedia` is called directly inside that
  click handler, with no message hop in between, or Chrome refuses it. The
  browser's own picker opens on tabs first; picking a whole window or screen
  shows a warning that everything visible will be in the recording. Avi's
  microphone is recorded with it so he can talk it through; tab sound is
  included when a tab is picked.
- **While recording.** A red mark and a timer in the panel with Stop. It also
  stops when the call ends, after two minutes of silence, or at ten minutes
  (a setting). The file is WebM, written in chunks to a Dexie table
  `recordingChunks` so a long recording does not sit in memory. That table is
  added to `EXCLUDED_TABLES` in `src/background/backup/snapshot.ts`, or
  scheduled backups would carry the videos.
- **Meeting notes keep running.** The offscreen document that records the
  meeting is created with the reasons `USER_MEDIA` and `AUDIO_PLAYBACK`
  (`src/background/offscreen.ts:29`) and cannot be recreated mid-call. The
  recording therefore runs in the panel. If the builder moves any of it to
  the offscreen document, `DISPLAY_MEDIA` is added in `createOffscreen` for
  every use, not swapped in during a call. The PR states the limits: what
  happens when the panel is closed mid-recording (the recording stops and
  what was captured is kept), and whether any manifest permission was added
  (none should be needed).
- **Saving.** To Google Drive, in "Ava recordings / <workspace> /
  <date> <task title>.webm". The token comes from the existing `google_drive`
  connector (`src/background/integrations/oauth.ts`) with the `drive.file`
  scope, which only reaches files Ava made. The upload uses Drive's resumable
  upload endpoint and saves the session address, so a retry after a dropped
  connection continues the same file. The file starts private.
- **Sharing.** The default is "anyone with the link can comment", as Avi
  asked, but the link is made only when Avi presses "Looks right" on the
  after-call list (Part 6) or "Share" on the task, after he could play the
  recording. There is no "allow every time" for making a recording public.
  Each shared recording has "Stop sharing" on its task, which makes the file
  private again. The link is added to the task's `links`.
- **When Drive is not connected.** The file is saved on this computer:
  `~/Movies/Ava recordings/…` through Ava Brain, or, when Ava Brain is off,
  a download started from the panel with a blob link (no new permission).
  The task shows where it is, and an Inbox item offers to connect Drive.
- Loom is not used: no free upload API. Drive is the default.

**Done when.** A click records a chosen tab with voice for 30 seconds while
meeting notes keep running; the file plays in Drive and is private until
shared; after "Share", the link opens for a signed-out browser (viewing;
Drive asks for a sign-in to comment); "Stop sharing" makes the link stop
working; with Drive off, the file is on disk and the task says where;
nothing records without a click; an upload retried after a dropped
connection makes one file, not two; a backup made after a recording does not
contain it.

## Part 8. Tasks on WhatsApp

*Model level: Opus, because it changes what Ava Brain lets through its
owner-only boundary. Needs Part 2.*

**The approach.** Every task list Ava sends is numbered, and Avi answers with
the number. Plain replies are matched in code, like the three commands that
exist today (`whatsapp-remote/commands.ts`). No model reads them.

**What Ava Brain must learn first** (`companion/src/whatsapp/`):

- `send()` returns the id of the message it sent, so the extension can keep
  which tasks a list carried.
- A reaction from the owner, and its removal (WhatsApp sends an empty
  reaction), is passed to the extension. It goes through the same
  `ownerChatFor` check as text, so a reaction from anyone else, or in any
  other chat, is still dropped before anything is kept.
- `tasks` is added to `WHATSAPP_NOTICE_KINDS`
  (`src/shared/lib/protocol/companion.ts`).

| Avi sends | What happens |
|---|---|
| `done 2` · `2 done` · `done 2 4 5` | Those tasks are marked done. Ava answers with the titles, struck through. |
| `undo 2` · `reopen 2` | Reopened. |
| A reply quoting a task list, saying `done 3` | Uses the numbers of the quoted list, however old. |
| A ✅ or 👍 reaction on a message that carries one task | That task is marked done. Removing the reaction reopens it. |
| `tasks` | Open tasks, numbered, most urgent first, at most 15. |
| `tasks ada` · `tasks ember` | Open tasks for that person or workspace. |
| `task for ada: send the deck by friday` | A new task (owner and due date worked out in code; unknown owner kept as said). |
| `drop 2` | Marked dropped. |
| `who's next` | Today's follow-ups (Part 9). |

- A bare number means the most recent list. Each list Ava sends is stored in
  a Dexie table `taskLists` as `{messageId, taskIds[], sentAt}` (ids only),
  so a quoted reply always maps to the right tasks. A number that is out of
  range gets "That list has 6 tasks. Which one?"
- `tasks <word>`: a person is tried first (`people.resolve`), then a
  workspace by name or keyword. If the word fits both, Ava asks which.
- Lists show at most 15 tasks, each one line: `3. Send the login to Ada
  (Fri)`. The task marker from Part 2 is stripped.
- **After a call** (Part 6): one message per person, "Tasks for Ada" with the
  numbered tasks, the due dates and any recording link, worded so it can be
  forwarded. More than five people become one combined message.
- **In the morning brief:** "Open tasks" (top 10) and "Follow up today".
- A new notice kind, `tasks`, with its own toggle beside the others. Quiet
  hours and the 20-an-hour cap hold. Task messages from a call that ends in
  quiet hours wait and are sent once at 07:00; answers to something Avi just
  sent go at once, as replies do today. Each message uses a do-once key.
- Polls are not used in this version: vote reading is unreliable in the
  Baileys release in use and a poll holds 12 options.

**Done when.** `done 2` after a list closes the right task and it shows
closed in the panel within a minute; quoting last week's list and answering
`undo 1` reopens that week's first task; a wrong number is asked about, not
guessed; a reaction on a one-task message closes it and removing it reopens
it; a reaction from another chat or another person changes nothing (a test
in the companion proves it is dropped); a call ending at 23:00 sends its task
messages at 07:00, once; none of this calls a model; tests cover every row of
the table.

## Part 9. Follow-ups: who is doing what, and who to chase

*Model level: Opus for the note reading and the timing rules, Sonnet for the
drafts and screens. Needs Parts 2, 5 and 8.*

### 9.1 What each person is doing

The meeting note gains a section the model fills from the call, one entry per
person who gave an update:

```ts
interface PersonUpdate {
  id: string;
  personId: string | null;   // resolved through people.resolve
  name: string;              // as said
  workspaceId: string | null;
  did: string[];             // what they said they finished
  doing: string[];           // what they are on now
  next: string[];            // what is expected next
  by?: string;               // ISO date, when one was said
  byText?: string;
  blockers: string[];
  source: { kind: 'meeting' | 'whatsapp' | 'manual'; id?: string };
  at: number;
}
```

Stored in a Dexie table `personUpdates`. A person's status is their latest
update plus their open tasks. A "did" that matches an open task of theirs is
offered as "Mark done?" on the after-call list; it is never closed without
Avi (the model's reading is not proof).

"Ava, what is Ada working on?" (`person_status`, voice tool and agent action)
answers from this: last did, doing now, expected next and when.

### 9.2 Who to chase, decided in code

A task whose owner is someone other than Avi is due a follow-up when any of
these is true:

- its due date has passed;
- it has no due date and nothing about it has been heard for three working
  days (no update from that person, no mention in a meeting);
- `followUp.nextAt` has come.

At most five follow-ups are shown a day, the most overdue first. They appear
under "Follow up today" in the brief, on WhatsApp, and as one Inbox item.
Weekends are skipped unless a due date falls on one.

### 9.3 The message, ready to send

Each follow-up comes with a draft the light model writes from fixed facts
(the person's name as Avi calls them, the task, where it came from, the date):

> Hi Ada, checking on the X login for Tech Ember Fest from Tuesday's call.
> Where has that got to?

Buttons: **Copy**, **Draft in WhatsApp** (types it into that person's chat in
Avi's WhatsApp Web tab and stops), **Asked** (records `askedAt`, sets the
next follow-up two working days on), **Done**, **Snooze** (one, three or
seven days). Ava never sends it.

When Avi writes back what the person said (in the panel or on WhatsApp:
`ada says the deck is with design, ready thursday`), it is stored as a
`PersonUpdate` and the follow-up clock restarts from the new date.

**Done when.** After a call where two people give updates, each has a status
with did, doing and next; a task three working days quiet appears under
"Follow up today" with a draft that names the right person and task; "Asked"
moves it two working days on; "Done" closes the task everywhere; the timing
rules are tested with a fake clock, including a weekend and a snooze.

---

## Later, on purpose

- Sync with Google Sheets, Notion or Linear. `Task.externalRefs` is there so
  a sync can be added without changing the store.
- Speaker voiceprints for calls without captions (`docs/ambient-plan.md`, A2).
- Messaging other people from Ava's own WhatsApp number
  (`docs/whatsapp-plan-b.md`).
- Tasks spoken outside calls through ambient listening.

## Build order

| Wave | Part | Model | Needs |
|---|---|---|---|
| 1 | 1 Typing box | Sonnet | — |
| 1 | 4 Vocabulary (composer chip after Part 1) | Sonnet | — |
| 1 | 2 Task board | Opus | — |
| 1 | 5 People | Opus | — |
| 2 | 3 Workspaces | Sonnet | 2 |
| 2 | 8 Tasks on WhatsApp | Opus | 2 |
| 2 | 7 Screen recording | Opus | — |
| 3 | 6 Tasks said on a call | Opus | 2, 5, 7 |
| 3 | 9 Follow-ups | Opus, then Sonnet | 2, 5, 8 |

New Dexie tables, by part: 2 `tasks`; 4 `vocabulary`; 5 `people`; 7
`recordingChunks`; 8 `taskLists`; 9 `personUpdates`.

Parts in one wave can be built side by side, with these known meeting points:

- **Dexie versions.** Every part above adds a `version()` step, and open PRs
  already claim 9, 10 and 11 (#98, #100, #101). No branch hard-codes "its"
  number: at merge time it rebases onto `feat/restyle` and takes the next
  free one.
- **`Composer.tsx`.** Parts 1 and 4 both edit it. Part 1 goes first; Part 4's
  chip and underline follow.
- **Voice and agent tool lists.** Parts 2, 3, 4, 5, 6 and 9 each add tools to
  `src/background/voice/prompt.ts` and the capability register. Each adds its
  own block and expects a rebase.
- **`src/background/meetings/manager.ts`.** Parts 4 (segment text) and 5
  (roster, speakers) both touch it. Each keeps its change inside its own
  function.
- **`src/background/brief/brief.ts`.** Part 2 rewrites the task lists. The
  growth team's "Team" section (issue #78) adds its own block to the same
  file; neither moves the other's block.

## Needed from Avi

1. Google Drive connected in Ava with the `drive.file` scope (Part 7). Until
   then recordings stay on this computer.
2. The first names to put in the vocabulary, if there are words beyond the
   workspace and product names (Part 4).
3. After the first call with Part 5 live: a minute to answer "who's who".
