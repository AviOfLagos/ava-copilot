# Voice per chat: one Ava, typed or spoken

**Problem.** Voice today is one global session, kept in its own "Voice" chat (tag `voice`), started from the mic in
the header. It picks up the last voice chat if it is under 12 hours old. Work it starts goes to *other* chats
(`voiceThreadId` links them). So typed Ava and spoken Ava have different histories, and Avi feels two AIs.

**Goal.** Voice is a way of talking *in a chat*, not a separate chat. Same history, same tools, same messages.

## 1. Talking inside a chat

- `VoiceManager.start({ threadId, tabId, windowId })`. The panel sends the chat on screen (`threadId`) and its tab.
  The session's `threadId` is that chat; no `voice` chat is created. The 12-hour "continue the last voice chat" rule
  goes away.
- What is heard and said is written into that chat as ordinary `user` / `planner` messages (`onTurn`, as today), so
  the chat reads as one conversation whether a line was typed or spoken. A small "spoken" mark on the message
  (`via: 'voice'`) lets the panel show a mic glyph; nothing else differs.
- The session starts with this chat's history (`voiceHistory` over its messages, which already include the answers of
  runs, because they are `planner` lines) plus the same identity, personality and capability sections as now.
- `run_browser_task` and `do_task` run **in this chat** (`threads.send({ threadId })`): the run's steps and answer
  show in the chat Avi is looking at. The spoken request is already the user message, so the run is started without
  adding a second copy of it. If this chat is already running, the request goes to a linked side chat, as today
  (`voiceThreadId`), and Ava says so in a few words.
- The watcher (`watch()`) stops skipping its own chat: when this chat's run finishes or waits for Confirm, Ava says it.
- Typing in the chat while voice is on keeps going to the voice session (as today), so it is one conversation.

## 2. Leaving the tab pauses; coming back resumes

- The session remembers its tab. On `tabs.onActivated` in that window, moving to a tab that is **not one of this
  chat's tabs** (its home tab, its work tabs in `tabPanels`, or a tab voice itself just opened or switched to with
  `open_tab` / `switch_tab`, which become work tabs) **pauses** it: mic off, socket closed, nothing billed.
  Switching apps (window blur) does not pause.
- Paused state: `{ threadId, tabId, pausedAt, resumeHandle }` in `storage.session`. The panel shows "Voice paused".
- Coming back to the tab within **10 minutes** resumes: same chat, mic on, and a visible line "Picking up where we
  were" plus a short spoken one ("Okay, back. We were on the invoice."). The offscreen mic needs no new click.
- After 10 minutes, or if the tab or its panel closes, the session ends. The chat gets "Voice ended while you were
  away"; the mic button starts it again.

## 3. Voice in another chat

Starting voice in chat B while it is on (or paused) in chat A ends A's session (A gets "Voice moved to B") and starts
B's with B's history. Ava in B can still reach A with `search_chats` / `read_chat`.

## 4. The header mic: keep one button (recommended)

Keep **one** mic in the header; what it does depends on the screen:

- A chat with messages is open: voice in **that** chat (section 1).
- An empty or new chat (or Home): a **new chat** on this tab that knows recent conversations. Its instructions get a
  short summary of the last 5 chats (title, when, last line, max ~800 characters, marked as history not orders), and
  it is told to use `search_chats` / `read_chat` for anything older.

One button is easier for Avi than "chat mic" vs "global mic". "Hey Ava" (wake word) follows the same rule on the tab
in front: that tab's chat if it has one, else a new chat on that tab.

## 5. Two tabs never both hold the mic

The background's single `VoiceManager` is the lock: one session (on or paused) at a time, owned by
`{ tabId, threadId }`. A start from any other tab moves it (section 3). Every panel hears voice status, but only the
panel whose chat owns the session shows the voice screen; others show nothing, or "Voice is on in <chat>". Meeting
notes "with my mic" already compete for the mic; that stays as is, out of scope.

## 6. Gemini Live versus the economy engine

| | Gemini Live | Economy (on-device speech + chat model) |
|---|---|---|
| Same brain as chat | Same history, tools and identity, but a different model (Live's audio model) | Same model as chat (voice-quick-win) |
| History | Sent once, in the instructions at connect (6,000 characters); lines added later by runs reach it as "System context" notes | Read from the chat on every turn, so it is always current; switch it from its own short turn list to the chat's messages |
| Pause / resume | Close the socket. Resume with the resumption handle while Google still accepts it (short-lived), else a fresh session with the chat's history. A new one-use token each time | Stateless: stop listening, start again. Nothing lost |
| Breaks | Tools are fixed at connect; a voice change restarts the session (as now); 15-minute audio limit (handled by resumption) | Local recognisers are English-only; slower replies |

## 7. Next problem (options only, no build)

How workspace or organisation history could reach voice later:

1. **Workspace first** (cheapest): `search_chats` already ranks the chat's workspace first; add the workspace's last
   few chats to the recent-chats summary.
2. **Workspace digest**: the reflect job keeps one short "where this workspace is at" note in the knowledge base;
   voice reads it at start (like `where_are_we`).
3. **Organisation memory**: shared notes synced through the Mac companion (Ava Brain), per person and with consent;
   only summaries leave the browser, never raw chats.

## What Avi will notice

- The mic in a chat talks *in that chat*: what he says and what Ava does appear there, as one conversation.
- Going to another tab pauses Ava; coming back, she says she is picking up where they were.
- The header mic on a new chat starts a fresh talk that still remembers recent chats.
