# Ambient — the scribe and the speak gate (logged 2026-10-24)

Roadmap item 12. Ava listens all the time, writes down what matters into the right workspace, and speaks only
when she is spoken to or has something worth the interruption: a friend in the corner of the room, not a
voice assistant waiting for a command. The wake word stays; this adds what happens around it.

Two parts, built in that order:

- **The scribe** listens without answering. Every word is transcribed on the Mac, split into topics, filed in the
  workspace each topic belongs to, and turned into decisions, commitments, reminders and ideas in the graph.
- **The speak gate** decides, moment by moment, whether to stay silent, take a note, raise a hand (a nudge), or
  speak, and learns from how Avi reacts.

The scribe ships first and runs for weeks before Ava speaks unprompted, so the gate learns from real data rather
than guesses.

## Rules (added to the roadmap's "Rules that never bend")

- **Ambient audio never leaves the Mac.** Ambient speech is transcribed by the local engines only
  (`src/offscreen/stt`, Moonshine/Whisper). No cloud model hears ambient audio. Raw audio is never stored; only
  transcripts are kept.
- **Ambient text stays on the Mac.** Topic splitting, filing, gate scoring and composing Ava's lines all use the
  local model from setup. Ambient text reaches a cloud model only if Avi turns on Settings › Ambient › "Let the cloud
  model use what Ava hears" (off by default), and then only the last ~2 minutes of it, to compose a line or seed a
  conversation. With it off, a conversation the gate opens starts from Avi's addressed words alone.
- **Ambient words are untrusted content.** Anything heard, Avi's voice included, is data, as a page is. It never
  triggers a tool. A request becomes a request only when Avi addresses Ava and the gate hands the moment to a voice
  conversation, where `reviewAction` and `voice/guard.ts` apply as today.
- **Only Avi's voice makes facts about Avi.** Facts come only from utterances matched to his voiceprint, and they
  arrive as *proposed* (`identity/facts.ts`) unless he turns on "Trust what I say around Ava". Other voices never
  make facts.
- **Off the record is instant.** "Ava, off the record" (or the toolbar) stops the scribe until "back on the
  record". Nothing from that stretch is transcribed. "Forget the last ten minutes" deletes it everywhere.
- **Listening is always visible.** The toolbar icon and the panel show the mode whenever the scribe runs.
- **Workspaces still never mix.** A topic is one item in one workspace. When a topic touches two workspaces, each
  side gets a link holding only the other's title. No content crosses.

## Modes

| Mode | Scribe | Speaks |
|---|---|---|
| Off | no | no |
| Wake word (today) | no | after "Hey Ava" |
| Listen | yes | only when addressed |
| Companion | yes | when addressed, plus nudges and occasional lines within the budget |

Spoken switches: "Ava, just listen" → Listen; "Ava, feel free to chime in" → Companion; "Ava, go quiet" → Wake
word. Saying "just listen" inside a conversation keeps the conversation open but silent until a question comes.

## Pipeline

```
offscreen mic (shared with wake.ts)
  → vad.ts speech gate → stt/utterances.ts (one utterance per turn)
  → local recogniser (stt/pool.ts)          → text + timings
  → speaker match (ambient/voiceprint)      → 'me' | 'other:n' | 'media' + confidence
  → background ambient/manager
       ├─ rolling transcript (last 10 min, in memory)
       ├─ scribe   (every 5 min and at session end)
       └─ gate     (every finished utterance, and on timers)
```

- An **ambient session** is continuous talk with gaps under 10 minutes. It is stored as a new
  `KnowledgeSourceType` `'ambient'`, with segments placed on a timeline the way `meetings/segments.ts` does it.
- **Media.** While any tab is audible (`chrome.tabs` `audible`) or Ava herself is speaking, the gate needs a
  voiceprint match for 'me' before anything counts as addressed. A voice that is neither enrolled nor clustered as
  a person in the room is `media`.
- **Power.** On battery below 30%, the recogniser drops to the smallest model and the scribe batches every 15
  minutes.

## Voiceprints (also roadmap item 10's audio-only mode)

- **Enrol:** Settings › Voice › "Teach Ava your voice": three phrases of about ten seconds. A local speaker-embedding
  model (ONNX, onnxruntime-web in an offscreen worker) gives one vector per utterance; the centroid is Avi's print.
  High-confidence matches nudge the centroid slowly, so it follows his voice over time.
- **Others:** voices that don't match are clustered per session as `other:1`, `other:2`. Saying "that was Tolu" names
  a cluster, and the print is kept for next time and for meetings.
- Prints stay in Dexie on the Mac and are never exported to the cloud. Backups encrypt them like the vault.

## The scribe

1. **Topic split.** Every 5 minutes, the local model cuts the new transcript into topics. A topic that runs on is
   merged with the previous one.
2. **Filing.** Each topic goes to `routeWorkspace(text, workspaces)` (as `threads/manager.ts` uses it), then to the
   workspace summaries as a tie-breaker. Below the confidence bar it lands in **Unsorted** with a suggested
   workspace, and the brief lists Unsorted until it is cleared. Inside a workspace, projects are graph nodes, so a
   topic touching two projects gets an edge to each.
3. **Extraction.** An ambient variant of `graph/extract.ts`'s reading pulls out decisions, commitments ("I'll send
   it Friday" → action item with owner and due date), reminders ("we're leaving at seven" → a timed reminder the
   gate can raise), ideas, people and open questions.
4. **Daily note.** Through the Obsidian integration, one `Ambient — YYYY-MM-DD.md` per workspace: topics, decisions,
   to-dos, and links to the items. Avi can edit it; the vault stays the source of truth.
5. **Recall** comes for free: the items are indexed, so "what did I say about pricing yesterday?" goes through
   `kb.ask` as any chat does.

## The speak gate

Lives in `src/background/ambient/gate/`. It runs on every finished utterance and whenever a reminder comes due.

### Stage 1 — rules (every utterance, no model)

Stay silent outright when:

- the mode is Listen and the moment is not addressed;
- Ava is off the record, in quiet hours, or past the hour's budget;
- a meeting is running (`meetings/manager`) and the meeting rules apply instead;
- media is playing and the speaker is not 'me';
- Ava spoke unprompted less than the cooldown ago.

Signals that Ava is addressed: her name or the wake word; a question in the second person followed by a pause that
no other voice fills within 2.5 s; a follow-up within 20 s of her last line. Each signal carries a weight. Stage 1
passes the moment on only when there is a trigger: a signal, a reminder due, or a scribe flag (a contradiction with
a recorded decision, or an open question Ava can answer from the KB).

### Stage 2 — score (local model, only when Stage 1 passes)

Returns `{ addressed: 0–1, value: 0–1, kind: 'answer' | 'reminder' | 'correction' | 'suggestion' | 'joke' }`.

- `addressed ≥ 0.8` → hand off: open a voice conversation (economy or Live, as set), seeded with the transcript
  window only when the cloud toggle is on or the conversation is economy (local). From there everything is the existing voice path, tools and gate included.
- Otherwise it is proactive, judged by kind against learned thresholds (starting at reminder 0.6, correction 0.8,
  suggestion 0.85, joke 0.9).

### The ladder

**silent → note → nudge → speak.** The default for anything proactive is a **nudge**: a soft chime and a one-line
card ("I've got a thought on the Ellum launch"). "Go on" makes Ava speak it; anything else lets it fade. Ava speaks
unprompted only for reminders whose time has come, or for a kind whose learned threshold has earned it (see
Learning). This is the realistic version of the friend in the corner: a raised hand first.

### Timing and manners

- Speak only when the floor is free, reusing the rules in `offscreen/turns.ts`: at least 1.2 s of silence after a
  finished turn, no one mid-sentence, no other voice starting.
- If the floor doesn't free within 20 s, step down to a nudge. If the moment has passed (the topic moved on), drop
  it.
- Anyone speaking over Ava stops her at once, as today.
- A proactive line is one or two sentences, composed by the local model (the cloud one only with the toggle on)
  with the identity prompt and the transcript window as untrusted content. It may use read-only tools (calendar, KB) and never a tool that writes.

### Budget (Settings › Ambient)

At most 3 unprompted lines an hour, 1 joke an hour, a 4-minute cooldown after each, doubled after a negative
reaction. Quiet hours default to 22:00–07:00.

## Learning from reactions

Every gate decision is a `GateEvent { at, kind, scores, decision, line?, reaction?, context }`, where `context`
holds the workspace, the hour, whether others are present, and the mode.

- **Labelled automatically within 15 s:**
  - Avi answers Ava or follows her up → positive.
  - "Not now", "stop", or talking over her within a second → negative.
  - The conversation simply carries on → mild negative.
  - Nudges: "go on" → positive, dismissed → negative, faded → mild negative.
- **Labelled by Avi:** "Ava, good one" / "don't do that again", or thumbs on the gate log.
- **Thresholds move**, per kind and per "others present / alone", within bounds: +0.03 after a negative, −0.01
  after a positive, never below the starting value minus 0.15, never above 0.98. Speaking unprompted, instead of
  nudging, unlocks per kind once its positive rate passes 70% over the last 30 events.
- **Weekly**, the reflection job (`identity/reflector.ts`) summarises the log into a short "How Avi likes Ava to
  chime in" block in the identity prompt, which Stage 2 reads. This is a Letta-style human block: edited, not
  regenerated.
- **Later**, past about 500 labelled events, train a small local classifier on the log to replace the Stage 2
  prompt.
- **"Why did you say that?"** (or the gate log in the panel) shows the scores, the signals and the threshold for
  any decision, including the times Ava stayed silent.

## Where the code goes

Follows the wave 2 contract: its own directories, plugged in from `register.ts`, long work as jobs.

| Path | What |
|---|---|
| `src/offscreen/ambient/` | the continuous tap on the shared mic stream; the speaker-embedding worker |
| `src/background/ambient/{manager,scribe,voiceprint,register}.ts` | sessions, the scribe jobs, speaker labels |
| `src/background/ambient/gate/{rules,score,ladder,policy}.ts` | Stage 1, Stage 2, the ladder and timing, thresholds and reactions |
| `src/storage/lib/ambient/` | Dexie tables: `ambientSessions`, `utterances` (TTL 30 days), `gateEvents`, `voiceprints` |
| `src/side-panel/…/ambient` | mode indicator; Ambient page with today's transcript, Unsorted, and the gate log with reasons |
| Settings › Ambient | mode, budget, quiet hours, "let the cloud model use what Ava hears" (off), "teach Ava your voice" |

**Later:** when roadmap item 11 (the desktop app) lands, the ears move from Brave's offscreen document into Nex
Brain as a native audio helper. The protocol between ears and background stays the same, so only the transport
changes.

## Build order (one PR each)

1. **A1 Listen mode.** Continuous local transcription into ambient sessions; modes and spoken switches; the
   indicator; off the record; forget; retention.
2. **A2 Voiceprints.** Enrolment, 'me'/'other'/'media' labels, naming a voice; reused by meetings.
3. **A3 Scribe.** Topic split, filing and Unsorted, extraction to the graph, reminders and commitments, the daily
   Obsidian note.
4. **A4 Gate, nudges only.** Stage 1, addressed detection, floor timing, hand-off to a voice conversation.
   Proactive moments are nudges only.
5. **A5 Gate, speaking.** Stage 2, the ladder, the budget, the reaction log.
6. **A6 Learning.** Threshold updates, unlock-to-speak, the weekly block, "why did you say that".

## Evals (`e2e/ambient/`, scripted audio fixtures and the mock model)

| Fixture | Expected |
|---|---|
| Two people talk about a project for 30 min; nobody addresses Ava | zero lines, at most one nudge |
| Same, with "Ava, what's on tomorrow?" in the middle | exactly one hand-off, answered |
| A TV clip that says "Hey Ava" | silent |
| A talk that moves from Nexprove to Tech Ember Fest | two items in two workspaces, each with a title-only link to the other |
| "We're leaving at seven" at 18:40 | a reminder line at about 18:55 if the floor is free, otherwise a nudge |
| "Off the record" … "back on" | nothing from between them anywhere |

Targets once A5 ships:

- fewer than one unwanted line per two hours of ambient talk;
- under 5% of addressed moments missed;
- at least 90% of fixture topics filed in the right workspace.

## Decided by Avi (2026-10-24)

- **Guests:** no announcement when a new voice appears; the toolbar shows that Ava is listening.
- **Cloud:** ambient text stays local only, unless Avi turns the cloud toggle on.
