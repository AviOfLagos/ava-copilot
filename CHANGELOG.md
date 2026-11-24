# Changelog

What changed in Ava Copilot, newest first, in plain words. Each line says what is different for the person using
Ava and links the pull request that made it. Dates are the day a change was merged.

This file is also the source of the [changelog page](https://ava.nexprove.com/changelog) on the website: the page is
built from it, so the two cannot drift. To add an entry, write it here. The format is fixed so the site can read it:

- `## <dates> · <label>` starts a week or a release. A label that starts with `next release` marks work that is
  merged but not in the download yet (everything after 0.2.6, released 24 November).
- `### <theme>` groups the lines.
- `- <what changed for the user>. ([#123](https://github.com/AviOfLagos/ava-copilot/pull/123))` is one line.
  Keep it to one line, no nested lists.

## 23–24 November 2026 · release 0.2.6

In the download from 0.2.6, released 24 November.

### Voice

- Voice and chat are one Ava: the mic talks inside the chat on screen, what you say is written there, and tasks you say out loud run in that same chat. ([#199](https://github.com/AviOfLagos/ava-copilot/pull/199))
- Switch tabs and voice pauses (mic off, nothing billed); come back and Ava picks up where you were. Ten minutes away or closing the tab ends it. ([#199](https://github.com/AviOfLagos/ava-copilot/pull/199))
- Voice uses the same model as chat by default, so it follows instructions as well as chat does, knows what it runs on, keeps to the language you chose, and says so when it can't hear you. ([#198](https://github.com/AviOfLagos/ava-copilot/pull/198))

## 22–23 November 2026 · release 0.2.5

In the download from 0.2.5, released 23 November.

### Working on pages

- Each tab has its own Ava panel and conversation. Come back to a tab and you carry on where you stopped; on a new tab, start fresh or open any past conversation. ([#195](https://github.com/AviOfLagos/ava-copilot/pull/195))
- Ask for something on another site and Ava opens a new tab for it instead of taking over the page you are on. ([#195](https://github.com/AviOfLagos/ava-copilot/pull/195))
- Ava can move the mouse over things, so buttons that only show on hover (like Pinterest's Save) can be found and clicked. ([#190](https://github.com/AviOfLagos/ava-copilot/pull/190))
- Auto mode: switch on "don't ask me for this task" and Ava stops showing confirm cards. It still asks before payments, deleting, changing access, and typing passwords or codes. ([#188](https://github.com/AviOfLagos/ava-copilot/pull/188))

### When something goes wrong

- Every automatic retry shows in the panel with a live countdown, like "Step failed — retrying in 4s (2 of 3)". ([#189](https://github.com/AviOfLagos/ava-copilot/pull/189))
- A broken reply from the model is sent back once with what was wrong, and failed steps wait a little longer each time and tell Ava what failed. ([#187](https://github.com/AviOfLagos/ava-copilot/pull/187))
- Models that refuse Ava's large list of actions (Gemini's "too many states") now switch to plain-text answers instead of failing. ([#186](https://github.com/AviOfLagos/ava-copilot/pull/186))
- WhatsApp no longer hangs on a dropped connection: it gives up on a stuck try after 45 seconds and tries again, shows "Connection lost. Trying again in…", and has a Reconnect now button. ([#196](https://github.com/AviOfLagos/ava-copilot/pull/196))

### Look and voice

- Settings → General → Look: text size (85–130%), spacing and light, dark or system theme, plus A− and A+ at the top of the panel. ([#191](https://github.com/AviOfLagos/ava-copilot/pull/191))
- Settings → Voice: presets, and Check this computer to measure how fast voices run on your Mac. ([#194](https://github.com/AviOfLagos/ava-copilot/pull/194))

## 16–22 November 2026 · release 0.2.4

In the download from 0.2.4, released 22 November.

### Your tasks

- Tasks are real now. Action items from your calls and tasks found in your chats go onto one board, each with an owner and a due date. A task said twice in nearly the same words is kept once. ([#121](https://github.com/AviOfLagos/ava-copilot/pull/121))
- Tick a box anywhere (the morning brief, a meeting note, a workspace summary) and that one task is done everywhere. Only boxes Ava made herself are live; a box a model typed into a reply is just text. ([#122](https://github.com/AviOfLagos/ava-copilot/pull/122))
- The morning brief shows one list per workspace: the five tasks due first, then “…and N more on the Tasks page”. ([#122](https://github.com/AviOfLagos/ava-copilot/pull/122))
- A **Tasks** page in the menu. Group by workspace or by person, filter by open, done or dropped; add, edit, give to someone, move, merge or drop a task, or close everything older than two weeks (it is dropped, and can be reopened). ([#123](https://github.com/AviOfLagos/ava-copilot/pull/123))
- Say or type “Ava, mark the login task done”. Add, finish, reopen, list, give and move tasks by voice or chat; when several tasks fit your words, Ava lists them and asks which. ([#123](https://github.com/AviOfLagos/ava-copilot/pull/123))
- Tasks on WhatsApp: send `tasks` and Ava sends your open tasks as a numbered list; `done 2` closes the second one; `undo 2` reopens it; `tasks for <name>` or `tasks in <workspace>` narrows the list; `task for <name>: <what>` adds one. A ✅ reaction on a task message closes it, and taking the reaction back reopens it. ([#125](https://github.com/AviOfLagos/ava-copilot/pull/125), [#124](https://github.com/AviOfLagos/ava-copilot/pull/124))
- The morning brief on WhatsApp now ends with your open tasks. Quiet hours and the hourly send limit still apply; a list that would go out in quiet hours waits and goes at 07:00. ([#125](https://github.com/AviOfLagos/ava-copilot/pull/125))
- Record your screen for a task in one click. A red mark and a timer show while it records, and the file goes to Google Drive (private until you press **Share**), or to a folder on your Mac through Ava Brain, or to Downloads. **Stop sharing** takes the link away again. Drive needs the Google Drive connector and has so far been tried only against a stand-in for Google, so this is a preview. The recording stops if you close the panel. ([#127](https://github.com/AviOfLagos/ava-copilot/pull/127))

### Your people

- Ava learns who is who, one workspace at a time, from Google Meet (who is in the call), calendar invites, Gmail senders, Slack direct messages, WhatsApp chats and GitHub. ([#118](https://github.com/AviOfLagos/ava-copilot/pull/118), [#119](https://github.com/AviOfLagos/ava-copilot/pull/119), [#120](https://github.com/AviOfLagos/ava-copilot/pull/120))
- After a call, and once a day at 17:30, a **Who's who** card asks short questions (“Is this the same person as…?”). Each answer is kept for that workspace and the question does not come back. ([#120](https://github.com/AviOfLagos/ava-copilot/pull/120))
- A **People** page with a “To sort” tab: see the names per workspace, edit, merge or remove them. A name never links an email address on its own, and nothing is shared between workspaces. ([#120](https://github.com/AviOfLagos/ava-copilot/pull/120))
- Tell Ava a note about a person in plain words, by voice or chat, and she keeps it with that person. ([#120](https://github.com/AviOfLagos/ava-copilot/pull/120))
- Meeting notes can name who said what even when Ava is recording audio, by matching the call's captions to the audio by time. ([#119](https://github.com/AviOfLagos/ava-copilot/pull/119))

### Workspaces

- **Make a workspace for these**: under the “No workspace” group in the brief and on the Tasks page, one button opens a sheet with a suggested name and keywords and a tick list of the things to move in. One confirm, and a 30-second Undo. ([#126](https://github.com/AviOfLagos/ava-copilot/pull/126))
- Say “make a workspace called…” and it is made at once, with the same Undo. ([#126](https://github.com/AviOfLagos/ava-copilot/pull/126))
- When two or more things in “No workspace” clearly belong to one workspace (its name, keywords, Google domain, or a person who only belongs there), they are moved for you, and the next brief says “Moved 3 things to…” with an Undo. A guess is only offered in the Inbox, and anything you placed yourself is never moved except by your own click. ([#126](https://github.com/AviOfLagos/ava-copilot/pull/126))
- A workspace can hold the facts of the product it sells: who it is for, the problem, pricing, the repository, the budget and more. Agents may state only what is written there; anything nobody filled in reads “not set” instead of being guessed. ([#95](https://github.com/AviOfLagos/ava-copilot/pull/95))

### Voice and typing

- The typing box has a full-width row of its own, grows with what you write, and has an expand control for long messages (Escape or sending shrinks it again). ([#116](https://github.com/AviOfLagos/ava-copilot/pull/116))
- **Vocabulary**: teach Ava the words she mishears (“when you hear Killon, write Quillon”), by voice, in chat or in Settings › Voice › Vocabulary. The right spelling is then used in dictation, WhatsApp voice notes, meeting notes, voice conversations and listen mode. Changed words are underlined for a few seconds with a one-click “Put back”, and a real word is never changed on its own. ([#117](https://github.com/AviOfLagos/ava-copilot/pull/117))
- Fixed: a video you attach in a chat now respects that chat's voice settings. ([#117](https://github.com/AviOfLagos/ava-copilot/pull/117))

### Your browser and tabs

- Ava knows every tab you have open, in every window, and reuses the right one: “Go to Facebook and reply to Ada” works in the Facebook tab you already have, and the chat says so. A tab another task is using is never taken, and private windows are never listed. ([#94](https://github.com/AviOfLagos/ava-copilot/pull/94))
- Close the tab Ava is working in and it is opened again on the same page, and the task carries on. If the tab was closed in the middle of a form or a send, nothing is reopened: the task is queued to try again and checks what already happened first. ([#85](https://github.com/AviOfLagos/ava-copilot/pull/85))
- A task that fails is tried again by itself after 1, 5 and 15 minutes when the cause is temporary (a page that would not load, the network, an overloaded model). When it still fails after the last try, you get one Inbox item and one WhatsApp line saying what is wrong. A failure that needs you (a model key, another extension on the tab) or cannot be done (a blocked site) is not retried: it gets one Inbox item saying why. ([#86](https://github.com/AviOfLagos/ava-copilot/pull/86))
- The morning brief says “Calendar: not connected” instead of “0 on the calendar”, names the sources it could not read, and counts what is really waiting for you, each thing once. ([#87](https://github.com/AviOfLagos/ava-copilot/pull/87))

### Safety and control

- **Allow once / Allow every time.** The confirm card has three buttons: Cancel, Allow once and Allow every time. “Every time” saves a rule for that kind of step on that site; it is shown in the chat when it is used, and **Settings › Allowed every time** lists every rule with a Remove button. Paying, deleting and giving access always ask and never get a rule. ([#92](https://github.com/AviOfLagos/ava-copilot/pull/92))
- Typing into Google Sheets (or any grid) no longer asks for a click per cell. Excel Online still asks. ([#92](https://github.com/AviOfLagos/ava-copilot/pull/92))
- **Do-once keys.** Every step that sends, posts, submits, grants or creates is written down before it runs. If a task is retried, resumed or the browser restarts, a step that already happened, or may have happened, is not run again unless you click to allow it, and the card says why. ([#83](https://github.com/AviOfLagos/ava-copilot/pull/83))

### Your team of agents

- Ava does short read-only check-ups through the day without being asked, of three kinds (a product pulse, a mail check, a stuck-work check), each left as one digest in the Inbox. After a quiet stretch she may make one offer, such as “Want me to sort your mail? 14 unread.” At most two a day; decline and she is quiet until tomorrow. Switch it off in Settings › General › Rounds and check-ins. ([#97](https://github.com/AviOfLagos/ava-copilot/pull/97))
- Ava reads a product's numbers (sign-ups, waitlist, feedback, active and paying organisations) from the product's own API with plain code, every two hours. So far this is built against one product's API. A number that could not be read says “no reading” and why; it is never shown as 0. ([#96](https://github.com/AviOfLagos/ava-copilot/pull/96))
- **Approval modes and a budget.** An agent's draft posts land in the Inbox as one row (“Approve all 3 drafts”). Spending, a new channel, a new account, a plan change, a new tool and anything that names a customer always ask you and can never become “every time”. The budget is kept by code: a request past it is refused before it reaches you. Nothing is posted or sent. ([#98](https://github.com/AviOfLagos/ava-copilot/pull/98))
- Three new personalities in Settings › Personalities: Growth lead, Positioning and outreach, and Builder in public. They are inspired by public work and never speak as the person; a draft that names them is refused. ([#99](https://github.com/AviOfLagos/ava-copilot/pull/99))
- **Growth Lead**: reads a product's new customer feedback, ranks each item, leaves one issue per feedback in the Inbox, and refuses a summary that holds a customer's email or phone number. Nothing is filed on GitHub yet: an approved issue is held until the step that files it is built. ([#100](https://github.com/AviOfLagos/ava-copilot/pull/100))
- **Product Marketing Manager**: ranks channels by the sign-ups each brought, suggests the cheapest untested ones, and drafts outreach that waits for your tap. Code refuses addresses on the do-not-write list, personal mailboxes, more than 20 new people a day and a second follow-up. Nothing is sent. ([#101](https://github.com/AviOfLagos/ava-copilot/pull/101))
- **Product Social Manager**: plans the week's posts and drafts posts and replies in a build-in-public voice. A number that neither the product facts nor the numbers back up is refused, and so is any quote of four words or more. Nothing is posted. ([#102](https://github.com/AviOfLagos/ava-copilot/pull/102))
- A weekly plan every Monday and a standup every morning: each growth agent writes a short note, the Growth Lead sums them up, and the Inbox shows “Growth standup” with anything that drifted from the plan named. ([#114](https://github.com/AviOfLagos/ava-copilot/pull/114))
- The morning brief has a **Team** section with the standup in a few lines, or “Standup did not run” and why. ([#115](https://github.com/AviOfLagos/ava-copilot/pull/115))

### Ava Brain and Ava Keys (Mac, for people who use coding agents)

- **Ava Keys** lets a coding agent that speaks MCP (set up for Claude Code today) ask Ava to run a command with your secrets. You approve each use with Touch ID, which shows the exact command, and the agent gets the output with every secret replaced by its name. Read the command before you approve it: a command you approve can still do anything with the secrets it is given. It needs a separate secrets vault on the Mac, set up by hand, so it is a preview. ([#62](https://github.com/AviOfLagos/ava-copilot/pull/62))
- Ava Keys can also switch the GitHub or Vercel account an agent works as, and tell you with a notification each time. It uses the `gh-switch` and `vercel-switch` helper scripts, which are not part of Ava and must already be on the Mac. ([#90](https://github.com/AviOfLagos/ava-copilot/pull/90))

### WhatsApp

- Ava's answers reach WhatsApp and the panel again: a bug that replaced every answer with “Session with ID … not found” is fixed, and messages that arrived while Ava's WhatsApp line was down are answered when it comes back (unless they are over 12 hours old, so a stale instruction is not acted on). ([#51](https://github.com/AviOfLagos/ava-copilot/pull/51))

### Calls and follow-ups

- Say “Ava, please note a task for <name>: <what>” during a call and it goes onto the task board for that person; after the call Ava lists the tasks, asks if anything is missing, and can send each person their tasks. [#150](https://github.com/AviOfLagos/ava-copilot/pull/150)
- Follow-ups: for each person, what they did last, what they are on now and what is next. Ava tells you who to chase and drafts the message for you to copy; nothing is sent for you. [#151](https://github.com/AviOfLagos/ava-copilot/pull/151)

### Ava knows her tools

- One list of every tool Ava has, checked by a test, so she never claims a tool she does not have or forgets one she does. [#154](https://github.com/AviOfLagos/ava-copilot/pull/154)
- Each place Ava works (WhatsApp, agents, routines, the panel) gets only the tools that work there, so “what can you do?” has a true answer everywhere. [#158](https://github.com/AviOfLagos/ava-copilot/pull/158)
- Chats can now read your calendar, the brief, the Inbox and your workspaces, which only voice could do before. [#161](https://github.com/AviOfLagos/ava-copilot/pull/161)
- Ava can look up facts she stored about you, not only the few that fit in the prompt. [#163](https://github.com/AviOfLagos/ava-copilot/pull/163)
- Voice Ava no longer says she cannot reach your chats or memory: when a model refuses tools, she says so instead of answering blind. [#155](https://github.com/AviOfLagos/ava-copilot/pull/155)

### Safety and control

- Once a chat has read a web page, an email or someone else's message, no saved “Allow every time” rule answers in it: you always see the card. [#171](https://github.com/AviOfLagos/ava-copilot/pull/171)
- “Allow every time” now also covers Drive, Meet voice, the Inbox and budget approvals. [#156](https://github.com/AviOfLagos/ava-copilot/pull/156)
- A retry never does the same thing twice: handing work to an agent, running an agent or a routine, and speaking in a meeting each happen once. [#160](https://github.com/AviOfLagos/ava-copilot/pull/160)
- Hosted tracing to Suture is a setting under Settings › Privacy, off by default, and message text is never sent unless you also switch that on. [#152](https://github.com/AviOfLagos/ava-copilot/pull/152)

### Voice, brief and workspaces

- Ava waits longer before answering, with a **Patience** setting, so she interrupts less. [#164](https://github.com/AviOfLagos/ava-copilot/pull/164)
- Settings say which speech recogniser is listening, and that the local ones understand English only. [#167](https://github.com/AviOfLagos/ava-copilot/pull/167)
- The morning brief names a calendar it cannot read, and Ava asks again for Mac Calendar access while it is missing; the setup checklist shows it too. [#153](https://github.com/AviOfLagos/ava-copilot/pull/153)
- Every workspace chat starts with a short card about that workspace. [#162](https://github.com/AviOfLagos/ava-copilot/pull/162)
- Long runs stay fast: old action results are cleared early and the chat is compacted sooner. [#159](https://github.com/AviOfLagos/ava-copilot/pull/159)
- Ava Keys can list your keys by name and show their status, never the values. [#165](https://github.com/AviOfLagos/ava-copilot/pull/165)

## 9–15 November 2026 · release 0.2.4

In the download from 0.2.4, released 22 November.

### Licence and setup

- Ava is **free for personal use** under the PolyForm Noncommercial licence. The code is public and contributions are welcome; commercial use needs permission. The parts that come from Nanobrowser stay Apache-2.0. Contributors sign their commits (DCO). ([#49](https://github.com/AviOfLagos/ava-copilot/pull/49))

### WhatsApp

- The setup step now says what it is: **Get a code to text Ava**, with no scan needed for it. ([#40](https://github.com/AviOfLagos/ava-copilot/pull/40))
- **Relink** works after WhatsApp signs Ava out: the dead login is cleared, so pairing a fresh code is possible again without losing your phone chat or settings. ([#50](https://github.com/AviOfLagos/ava-copilot/pull/50))

## 26 October – 1 November 2026 · release 0.2.4

In the download from 0.2.4, released 22 November.

### WhatsApp

- Ava reads **voice notes, photos, documents and links** sent on WhatsApp. Voice notes are written down on your computer; photos go to the model as pictures; documents are read on your Mac and saved to the workspace's knowledge. ([#21](https://github.com/AviOfLagos/ava-copilot/pull/21))
- Ava answers like a person: a voice note back for a voice note (in the voice you chose, made on your computer), “typing…” while she works, 👍 when work takes a while and ✅ when the answer goes, and quote-replies when you wrote more than once. You can also say “delete that”, “change that to…” or “react 🔥 to that”. ([#27](https://github.com/AviOfLagos/ava-copilot/pull/27))
- An answer is no longer lost when the browser restarts while a voice note is being made. ([#31](https://github.com/AviOfLagos/ava-copilot/pull/31))

### Voice

- Ava waits for the end of your sentence (a 1.2 second pause, and longer after a word that clearly continues), joins fragments into one turn, and mostly ignores speech that is not meant for her, such as a radio across the room (a loud one right next to the microphone can still get through). ([#26](https://github.com/AviOfLagos/ava-copilot/pull/26))
- A **Voice** control in each chat sets who hears, who speaks and the language for that chat. With a Gemini key, voice conversations, dictation and WhatsApp voice notes use Gemini by default and fall back to the local recogniser; choose the economy setting or a local recogniser in a chat to keep that audio on your computer. ([#30](https://github.com/AviOfLagos/ava-copilot/pull/30))

### Answers and checks

- Ava never shows an empty or “None” answer. She asks the model once more and, if that fails, says so. A greeting like “Hi” no longer pulls in a skill. ([#28](https://github.com/AviOfLagos/ava-copilot/pull/28))
- For builders: `pnpm eval` replays every failure found so far through Ava's real code with no model and no network, and CI runs it. ([#29](https://github.com/AviOfLagos/ava-copilot/pull/29))

### Ava Brain

- Ava Brain keeps your Calendar permission when Node is upgraded, and its installer never leaves it stopped after a reinstall. ([#22](https://github.com/AviOfLagos/ava-copilot/pull/22), [#23](https://github.com/AviOfLagos/ava-copilot/pull/23))

## 19–25 October 2026 · releases 0.2.1, 0.2.2 and 0.2.3

### 0.2.3 · 25 October

- Voice never gets stuck: a speech recogniser that stalls is replaced and Ava listens again, and a turn that takes over two minutes ends with “That took too long”. ([#10](https://github.com/AviOfLagos/ava-copilot/pull/10), [#11](https://github.com/AviOfLagos/ava-copilot/pull/11))

### 0.2.2 · 25 October

- After an update, the panel shows what is new until you press **Got it**, with one desktop notification per version. ([#7](https://github.com/AviOfLagos/ava-copilot/pull/7), [#8](https://github.com/AviOfLagos/ava-copilot/pull/8))
- Answers read aloud use a voice on your computer (KittenTTS, then Kokoro) until you pick another engine. ([#7](https://github.com/AviOfLagos/ava-copilot/pull/7))

### 0.2.1 · 25 October

- The new name, **Ava Copilot**, with Ava Brain for the Mac companion, the website at ava.nexprove.com, and problem reports through GitHub issues (Settings › Help › Report a problem). ([#6](https://github.com/AviOfLagos/ava-copilot/pull/6))

### Also this week

- **Listen mode**: Ava writes down what is said around your Mac, on your Mac only, and stays quiet. “Off the record” stops it at once, and the toolbar shows when it is listening. ([#2](https://github.com/AviOfLagos/ava-copilot/pull/2))
- **WhatsApp** through Ava Brain: connect your phone, keep the link across restarts, log out. ([#17](https://github.com/AviOfLagos/ava-copilot/pull/17), [#16](https://github.com/AviOfLagos/ava-copilot/pull/16))
- The installer shows download progress and resumes and retries when a slow connection drops. ([#9](https://github.com/AviOfLagos/ava-copilot/pull/9))
- Quick fixes to the Obsidian, Ollama and Calendar connections. ([#15](https://github.com/AviOfLagos/ava-copilot/pull/15))
- The website: features, roadmap, contribute and donate pages, one-line install commands and a link preview card for every page. ([#3](https://github.com/AviOfLagos/ava-copilot/pull/3), [#4](https://github.com/AviOfLagos/ava-copilot/pull/4), [#5](https://github.com/AviOfLagos/ava-copilot/pull/5))
