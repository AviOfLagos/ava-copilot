/*
 * The project pages' words: every feature, the roadmap, how to contribute, and donations. Like site.ts, components
 * only read from here. Status is honest: 'live' ships in the current build, 'preview' ships but is still rough (the
 * app calls it a sneak peek), 'planned' is not built yet. Sources: docs/task.md and docs/roadmap.md in the repo.
 */
import { ASSISTANT, COMPANION, PRODUCT } from './site';

export type Status = 'live' | 'preview' | 'planned';

export const statusLabel: Record<Status, string> = {
  live: 'Live',
  preview: 'Preview',
  planned: 'Planned',
};

/** The source repository. Private while the project gets ready for outside contributors. */
export const REPO = 'https://github.com/AviOfLagos/ava-copilot';

export const projectLinks = {
  features: '/features',
  roadmap: '/roadmap',
  changelog: '/changelog',
  contribute: '/contribute',
  donate: '/donate',
  repo: REPO,
  issues: `${REPO}/issues`,
  newIssue: `${REPO}/issues/new/choose`,
  goodFirst: `${REPO}/issues?q=is%3Aopen+label%3A%22good+first+issue%22`,
  discussions: `${REPO}/discussions`,
  security: `${REPO}/security/advisories/new`,
  contributing: `${REPO}/blob/feat/restyle/CONTRIBUTING.md`,
  releasesFeed: '/releases.xml',
};

// ─── Features ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Feature {
  name: string;
  /** What it is. */
  body: string;
  status: Status;
  /** What you do to use it. */
  you?: string;
  /** What tells you it is on. */
  on?: string;
}

export interface FeatureGroup {
  id: string;
  title: string;
  lede: string;
  items: Feature[];
}

export const features = {
  title: `Every feature of ${PRODUCT} — what ships today and what is next`,
  description: `The full list of what ${PRODUCT} does: it works in your browser and tabs, keeps your tasks and the people in them, takes meeting notes, talks, answers on WhatsApp, runs a team of agents and works with any model. Each feature is marked live, preview or planned.`,
  ogAlt: `${PRODUCT}: every feature, marked live, preview or planned.`,
  breadcrumb: 'Features',
  heading: 'Everything it does.',
  lede: `Each feature is marked as it really is in the code today. ${ASSISTANT} is the assistant you talk to; ${PRODUCT} is the extension she lives in. Some of what is below is merged but arrives with the next download: the changelog says which.`,
  legend: 'What the marks mean',
  legendItems: [
    { status: 'live' as Status, text: 'In the current build.' },
    { status: 'preview' as Status, text: 'In the build, still rough.' },
    { status: 'planned' as Status, text: 'Designed, not built yet.' },
  ],
  jump: 'Jump to',
  groups: [
    {
      id: 'browser',
      title: 'Your browser and tabs',
      lede: 'Ask in plain words. It plans, clicks and types on the pages you already use, in the tabs you already have open, and shows every step.',
      items: [
        {
          name: 'Browser agent',
          body: 'A planner, a navigator and a checker work through the task on live pages, and correct themselves when a page changes.',
          status: 'live',
        },
        {
          name: 'Several chats at once',
          body: 'Each chat runs on its own tabs, side by side, without stepping on the others.',
          status: 'live',
        },
        {
          name: 'Forms in one pass',
          body: 'Fills every field it knows at once, asks for the rest in one card, then fills those.',
          status: 'live',
        },
        {
          name: 'Your turn',
          body: 'Hands a sign-in or a choice back to you, and carries on when you press Continue.',
          status: 'live',
        },
        { name: 'Stop at any step', body: 'One button stops a chat; another stops them all.', status: 'live' },
        {
          name: 'Knows every open tab',
          body: 'It is told which sites you have open, in every window, and works in the right tab instead of opening a new one. A tab another task is using is never taken, and private windows are never listed.',
          status: 'live',
          you: 'Ask for something on a site you already have open, such as “Go to Facebook and reply to Jo”.',
          on: 'The chat says “Using the facebook.com tab you already have open.”',
        },
        {
          name: 'A closed tab comes back',
          body: 'Close the tab a task is working in and it is opened again on the same page, and the task carries on. If it was closed in the middle of a form or a send, nothing is reopened: the task waits to try again and checks what already happened.',
          status: 'live',
          you: 'Nothing. Press Stop if you meant to end it.',
          on: 'The next look at the page says the tab was closed and reopened.',
        },
        {
          name: 'Tries again, then tells you',
          body: 'A task that fails for a temporary reason (a page that would not load, the network, a busy model) is tried again after 1, 5 and 15 minutes; if it still fails, one Inbox item and one WhatsApp line say what is wrong. A failure that needs you (a model key) or cannot be done (a blocked site) is not retried: it gets one Inbox item saying why.',
          status: 'live',
          you: 'Nothing, unless it asks. Retry or Stop at any time.',
          on: 'The chat says “Trying again in 1 min (try 1 of 3)”.',
        },
        {
          name: 'Hidden instructions ignored',
          body: 'Text on a page that tries to give it orders is treated as data, never as a request.',
          status: 'live',
        },
        {
          name: 'Schedule posts on social sites',
          body: 'Queues posts on X, LinkedIn, Instagram and YouTube with the right workspace’s account; the post itself still waits for your click.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'gate',
      title: 'The gate',
      lede: 'Nothing is sent, posted, bought, deleted or committed without your click: on the card, or on a rule you saved with a click. Paying, deleting and giving access are never remembered.',
      items: [
        {
          name: 'Confirm before it commits',
          body: 'Six kinds of action wait for your click: send, post, submit, buy, delete and permission changes.',
          status: 'live',
        },
        {
          name: 'Unattended work asks too',
          body: 'Routines and agents that reach a commit stop and wait in your Inbox.',
          status: 'live',
        },
        {
          name: 'Secret scan on commits',
          body: 'Anything that would commit to GitHub is scanned for keys and tokens first; a hit blocks it.',
          status: 'live',
        },
        { name: 'Drafts, not sends', body: 'Email and Slack replies are drafts you send yourself.', status: 'live' },
        {
          name: 'Allow once, or every time',
          body: 'The confirm card has three buttons: Cancel, Allow once and Allow every time. “Every time” saves a rule for that kind of step on that site. Paying, deleting and giving access never get a rule.',
          status: 'live',
          you: 'Hold the button you want. Settings › Allowed every time lists each rule, how often it was used, and a Remove button.',
          on: 'The chat shows “Allowed every time: …” whenever a rule is used, so it is never silent.',
        },
        {
          name: 'Nothing runs twice',
          body: 'Every step that sends, posts, submits, grants or creates is written down before it runs. After a retry or a restart, a step that already happened, or may have, is not run again unless you click to allow it.',
          status: 'live',
          you: 'Read the card and decide.',
          on: 'The confirm card says the step may be a repeat, and why.',
        },
        {
          name: 'Spreadsheets without a click per cell',
          body: 'Typing into Google Sheets or any grid no longer stops for every cell, and a cell that says “Send” is not a send button. Excel Online still asks.',
          status: 'live',
        },
      ],
    },
    {
      id: 'tasks',
      title: 'Your tasks and people',
      lede: 'What was agreed lands on one board and stays ticked wherever you see it. Ava learns who is who, one workspace at a time, and asks when she is not sure.',
      items: [
        {
          name: 'One board for every task',
          body: 'Action items from your calls and tasks found in your chats go onto one board, each with an owner and a due date. A task said twice in nearly the same words is kept once. A web page never makes a task.',
          status: 'live',
          you: 'Nothing: they arrive. Add your own on the Tasks page.',
          on: 'Tasks, in the menu after Inbox.',
        },
        {
          name: 'Tick it anywhere',
          body: 'Tick a box in the morning brief, a meeting note or a workspace summary and that one task is done everywhere. Only boxes Ava made herself are live. The brief shows one list per workspace: the five due first, then “…and N more on the Tasks page”.',
          status: 'live',
          you: 'Tick the box.',
          on: 'It shows done on the Tasks page and in the note it came from; untick it there and the brief follows.',
        },
        {
          name: 'The Tasks page',
          body: 'Group by workspace or by person and filter by open, done or dropped. Add, edit, give to someone, move, merge or drop a task, or close everything older than two weeks (it is dropped, and can be reopened).',
          status: 'live',
        },
        {
          name: 'By voice or chat',
          body: 'Add, finish, reopen, list, give and move tasks in your own words. When several tasks fit what you said, she lists them and asks which.',
          status: 'live',
          you: 'Say or type “Ava, mark the login task done”.',
        },
        {
          name: 'Names from your tools',
          body: 'Ava learns who is who from Google Meet (who is in the call), calendar invites, Gmail senders, Slack direct messages, WhatsApp chats and GitHub. A name never links an email address on its own, and nothing is shared between workspaces.',
          status: 'live',
        },
        {
          name: 'Who’s who cards',
          body: 'After a call, and once a day at 17:30, a card asks short questions: is this the same person as another name you have seen? Each answer is kept for that workspace and the question does not come back.',
          status: 'live',
          you: 'Answer yes, same as another name, someone else, new person, or not a person.',
          on: 'The card in the Inbox, and under the meeting’s note.',
        },
        {
          name: 'The People page',
          body: 'Every person by workspace, with a “To sort” tab for names she is unsure of. Edit, merge or remove them.',
          status: 'live',
        },
        {
          name: 'Tell her about a person',
          body: 'A note about someone, said or typed in your own words, is kept with that person. A chat started by an agent, a routine or the brief cannot add one.',
          status: 'live',
        },
        {
          name: 'Screen recording for a task',
          body: 'Record a tab, a window or the whole screen for a task. It is saved to Google Drive (when the Drive connector is connected) and kept private until you press Share, or to a folder on your Mac through Ava Brain, or to Downloads. Stop sharing takes the link away again. The recording stops if you close the panel.',
          status: 'preview',
          you: 'Press Record screen on the task. Choosing a window or a whole screen asks you to confirm first.',
          on: 'A red mark, a timer and Stop in the panel while it records.',
        },
        {
          name: 'Note a task on a call',
          body: 'Say “Ava, note a task for Sam” in a call and it is on the board.',
          status: 'planned',
        },
        {
          name: 'Who to chase',
          body: 'Ava tells you who is due a follow-up and drafts the message for you to send.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'voice',
      title: 'Voice',
      lede: `Say “Hey ${ASSISTANT}”, or press Talk. It can run entirely on your computer.`,
      items: [
        {
          name: `“Hey ${ASSISTANT}” wake word`,
          body: 'Recognised on the device. Nothing leaves your computer until it hears the phrase.',
          status: 'live',
        },
        {
          name: 'Fully local conversations',
          body: 'Moonshine or Whisper listen, a local or cloud text model answers, and KittenTTS or Kokoro speak. Or use Gemini Live.',
          status: 'live',
        },
        {
          name: '16 local voices',
          body: 'Eight KittenTTS and eight Kokoro voices, free and on your computer, downloaded on first use.',
          status: 'live',
        },
        { name: 'Dictation you can see', body: 'Speak into the chat box and watch the words arrive.', status: 'live' },
        {
          name: 'Words Ava mishears, written right',
          body: 'Teach her the words she gets wrong and they are corrected in dictation, WhatsApp voice notes, meeting notes, voice conversations and listen mode. A real word is never changed on its own: a small chip asks first.',
          status: 'live',
          you: 'Say “when you hear Killon, write Quillon”, or add it in Settings › Voice › Vocabulary. Fix a word by hand after dictating and she offers to remember it.',
          on: 'Changed words are underlined for a few seconds; click one to put it back.',
        },
        {
          name: 'A typing box with room',
          body: 'The box has a full-width row of its own and grows with what you write. An expand control opens it to most of the panel for long messages.',
          status: 'live',
          you: 'Press the expand control, or Escape to shrink it again.',
        },
        {
          name: 'Voice settings per chat',
          body: 'Each chat can set who hears, who speaks and the language. With a Gemini key, voice conversations, dictation and WhatsApp voice notes use Gemini by default and fall back to a recogniser on your computer; choose economy or a local recogniser to keep that audio on your computer.',
          status: 'live',
          you: 'The Voice control in the chat bar.',
        },
        {
          name: 'Waits for the end of your sentence',
          body: 'A thinking pause no longer ends your turn, and speech that is not meant for her, such as a radio across the room, is mostly ignored.',
          status: 'live',
        },
        {
          name: 'One conversation, typed or spoken',
          body: 'Switch between talking and typing in the same chat, with pictures and video.',
          status: 'live',
        },
        {
          name: 'Personalities',
          body: 'Tone and voice you can switch, on top of a core identity that never changes.',
          status: 'live',
        },
      ],
    },
    {
      id: 'ambient',
      title: 'Ambient listening',
      lede: `${ASSISTANT} listens around you, writes down what matters into the right project, and speaks only when it is worth it.`,
      items: [
        {
          name: 'Listen mode',
          body: 'Writes down what is said near your Mac, on your Mac only, and never answers unless you use the wake word.',
          status: 'live',
        },
        {
          name: 'Off the record',
          body: '“Off the record” stops it at once; “forget the last ten minutes” deletes that stretch everywhere.',
          status: 'live',
        },
        {
          name: 'Always visible',
          body: 'A dot on the toolbar icon and an ear in the panel whenever it listens.',
          status: 'live',
        },
        {
          name: 'Knows your voice',
          body: 'A voiceprint tells you apart from guests and from the TV; it never leaves your computer.',
          status: 'planned',
        },
        {
          name: 'Files talk by project',
          body: 'Splits talk into topics, files each in its workspace, creates a workspace for a new project, and keeps a daily note.',
          status: 'planned',
        },
        {
          name: 'A raised hand',
          body: 'A quiet nudge first (“I have a thought on that”), speaking up only when you say “go on”.',
          status: 'planned',
        },
        {
          name: 'Learns when to speak',
          body: 'Learns from how you react which comments, reminders and jokes you welcome.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'meetings',
      title: 'Meetings',
      lede: 'Notes for Google Meet, from the moment you join.',
      items: [
        {
          name: 'Meeting notes',
          body: 'Starts when you join, names speakers from the captions, and hands back a summary with action points.',
          status: 'live',
        },
        {
          name: 'Who said what',
          body: 'Reads who is in the call from Meet, and gives each stretch of audio its speaker by matching the captions by time. People you meet are offered to your People page.',
          status: 'live',
        },
        {
          name: 'Action items go to your board',
          body: 'What was agreed becomes tasks with an owner and a due date, on the same board as everything else.',
          status: 'live',
          on: 'The note’s checkboxes tick the real task.',
        },
        {
          name: 'Call control',
          body: '“Leave the call” leaves quietly; “end the call” ends it for everyone, on your own words only.',
          status: 'live',
        },
        {
          name: `${ASSISTANT} in the meeting`,
          body: 'She can join as her own participant and answer when asked.',
          status: 'preview',
        },
        {
          name: 'Set up a call',
          body: '“Set up a call with Sam” creates it from the right workspace’s Google account.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'whatsapp',
      title: 'WhatsApp',
      lede: 'Message Ava from your phone and she answers through your computer. Anything that sends, posts, buys or deletes still waits for your click.',
      items: [
        {
          name: 'Message Ava',
          body: 'She answers in your own “Message yourself” chat, or from a number of her own that only talks to you. It runs through Ava Brain on your Mac, so the Mac has to be on and your browser open. Every other chat is ignored.',
          status: 'preview',
          you: 'Pair Ava Brain, then Settings › WhatsApp › Link WhatsApp and scan the code. If Ava has a number of her own, text her the short code it shows.',
          on: 'Settings › WhatsApp says when you last wrote and when she last answered. “Send a test message” checks it.',
        },
        {
          name: 'Reads more than text',
          body: 'Voice notes are written down on your computer, photos go to the model as pictures, and documents and links are read and saved to the workspace’s knowledge.',
          status: 'preview',
        },
        {
          name: 'Answers like a person',
          body: 'A voice note back for a voice note, in the voice you chose. “typing…” while she works, 👍 when it takes a while and ✅ when the answer goes. Say “delete that” or “react 🔥 to that” and she does.',
          status: 'preview',
        },
        {
          name: 'Tasks on WhatsApp',
          body: 'Send tasks and she sends your open ones as a numbered list. done 2 closes the second; undo 2 reopens it. tasks for a person or tasks in a workspace narrows the list, and task for a person: what adds one. A ✅ on a task message closes it.',
          status: 'preview',
          you: 'Type the command, or react.',
          on: 'She confirms with the tasks struck through.',
        },
        {
          name: 'Messages you first',
          body: 'When a chat waits for your approval, meeting notes are ready, the brief is ready, a reminder or routine has a result, or a task list is ready (after a call, or your open tasks). Quiet hours hold all of these except approvals, and there is an hourly send limit.',
          status: 'preview',
          you: 'Choose what she may message you about, and the quiet hours, in Settings › WhatsApp.',
        },
        {
          name: 'An unofficial client',
          body: 'Ava uses an unofficial WhatsApp Web client on your Mac. WhatsApp can restrict a number that uses one, which is why it is a preview. If WhatsApp signs her out, Relink pairs a fresh code and keeps your settings.',
          status: 'preview',
        },
      ],
    },
    {
      id: 'memory',
      title: 'Memory',
      lede: 'It remembers what you saw, said and decided, and answers with the source.',
      items: [
        {
          name: 'Knowledge base',
          body: 'Chats, meeting notes, saved pages and notes, searched by meaning and by keyword, with cited answers.',
          status: 'live',
        },
        {
          name: 'Knowledge graph',
          body: 'People, projects, decisions and actions as linked nodes you can explore.',
          status: 'live',
        },
        {
          name: 'Your Obsidian vault',
          body: 'Reads your notes, and writes the graph back as Markdown.',
          status: 'live',
        },
        {
          name: 'Knows you',
          body: 'Facts you told it, current goals and a daily reflection, always in context. You see and edit all of it.',
          status: 'live',
        },
        {
          name: 'Bring in your AI history',
          body: 'Imports past conversations from other AI tools, redacted and filed by project.',
          status: 'preview',
        },
        {
          name: 'Survives an uninstall',
          body: 'Back up memory and settings to a file and bring them back.',
          status: 'live',
        },
      ],
    },
    {
      id: 'workspaces',
      title: 'Workspaces',
      lede: 'One per project or company, each with its own accounts and knowledge. They never mix.',
      items: [
        {
          name: 'Accounts per workspace',
          body: 'Google, X, LinkedIn, YouTube, Instagram and Slack per workspace; it switches account before acting.',
          status: 'live',
        },
        {
          name: 'Routed by your words',
          body: 'Every request lands in one workspace; when it is unclear, it asks.',
          status: 'live',
        },
        {
          name: 'Make one in a click, or by voice',
          body: 'Under “No workspace”, one button opens a sheet with a suggested name and keywords and a tick list of the chats, meetings, tasks and notes to move in. Or say “make a workspace called…”.',
          status: 'live',
          you: 'Press Make a workspace for these, check the list, confirm.',
          on: 'A 30-second Undo in the sheet, and later in the Inbox.',
        },
        {
          name: 'Sorted for you, by rule',
          body: 'When two or more things in “No workspace” clearly belong to one workspace (its name, keywords, Google domain, or a person who belongs only there), they are moved. A guess is only offered in the Inbox, and anything you placed yourself is never moved except by your own click.',
          status: 'live',
          on: 'The next brief says “Moved 3 things to…” with an Undo.',
        },
        {
          name: 'The product it sells',
          body: 'A workspace can hold the facts of a product: who it is for, the problem, pricing, the repository, the budget and more. Agents may state only what is written there.',
          status: 'live',
          you: 'Workspaces › a workspace › Add the product this workspace sells.',
          on: 'Anything nobody filled in reads “not set”, never a guess.',
        },
        {
          name: 'Created for you',
          body: 'A project that keeps coming up gets its own workspace; small things go to Misc until they grow.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'automation',
      title: 'Routines and agents',
      lede: 'Work that runs on a schedule or on its own, and still asks before it commits.',
      items: [
        {
          name: 'Morning brief',
          body: 'Every morning: your calendar, open threads, one task list per workspace and what to do first. It says “not connected” for a source it could not read, instead of showing 0, and counts what is really waiting for you, each thing once.',
          status: 'live',
          on: 'The brief ends with the sources it read and the ones it could not.',
        },
        {
          name: 'Check-ups and offers',
          body: 'With no instructions all day, Ava still does three read-only rounds (a product pulse, a mail check and stuck work) and leaves one short digest for each in the Inbox. After a quiet stretch she may make one offer, such as “Want me to sort your mail? 14 unread.” Nothing here sends, posts or grants anything.',
          status: 'live',
          you: 'Approve an offer, or decline it: she is quiet until tomorrow. Settings › General › Rounds and check-ins has the switch and each round’s times.',
          on: 'Digests in the Inbox; at most two offers a day.',
        },
        {
          name: 'Routines',
          body: 'Steps that run on a schedule or a trigger, built by describing them.',
          status: 'live',
        },
        {
          name: 'Helper agents',
          body: 'Agents with their own job, memory and budget, and a log of every run.',
          status: 'live',
        },
        {
          name: 'Inbox',
          body: 'Everything waiting for you in one place: approvals, results and new messages from your sources.',
          status: 'live',
        },
        {
          name: 'Skills',
          body: 'Playbooks for sites and tasks. After a task works, it offers to save the route as a skill.',
          status: 'live',
        },
      ],
    },
    {
      id: 'team',
      title: 'Your team of agents',
      lede: 'Three agents that work for a product you sell. They plan the week, meet every morning and draft what needs saying. They draft; you decide. Nothing is posted or sent yet.',
      items: [
        {
          name: 'Growth Lead',
          body: 'Reads a product’s new customer feedback, ranks each item by a fixed rule, and leaves one issue per feedback in your Inbox. Nothing is filed on GitHub yet: an approved issue is held until the step that files it is built. Code refuses a summary that holds a customer’s email or phone number.',
          status: 'preview',
          you: 'Agents › Set up my team now › Growth team. Needs the product’s facts in a workspace.',
          on: 'An issue such as “[P0] …” waits in the Inbox.',
        },
        {
          name: 'Product Marketing Manager',
          body: 'Ranks channels by the sign-ups each brought, suggests the cheapest ones not yet tested, and drafts outreach that waits for your tap. Code refuses addresses on the do-not-write list, personal mailboxes, more than 20 new people a day and a second follow-up.',
          status: 'preview',
          on: 'Every draft ends with who it is from and how to opt out; what nobody gave reads “not set”.',
        },
        {
          name: 'Product Social Manager',
          body: 'Plans the week’s posts and drafts posts and replies in a build-in-public voice. A number that neither the product’s facts nor its real numbers back up is refused, and so is any quote of four words or more.',
          status: 'preview',
        },
        {
          name: 'Weekly plan and daily standup',
          body: 'Every Monday the Growth Lead sets one focus and up to three experiments. Every morning each agent writes a short note and the Lead sums them up, naming anything that drifted from the plan.',
          status: 'preview',
          you: 'Open “Growth standup” in the Inbox, or press Run today’s standup on the Growth Lead’s page.',
          on: 'A team section in the morning brief, or “Standup did not run” and why.',
        },
        {
          name: 'Approvals in one row',
          body: 'An agent’s draft posts land in the Inbox as one row (“Approve all 3 drafts”). Spending, a new channel, a new account, a plan change, a new tool and anything that names a customer always ask you and can never become “every time”.',
          status: 'live',
        },
        {
          name: 'A budget kept by code',
          body: 'The budget and the beta places are a ledger in code. A request past the budget is refused before it reaches you, and the sixth beta place in a week is refused even if you click yes on six at once.',
          status: 'live',
          on: 'The workspace shows what is spent and what is left.',
        },
        {
          name: 'Real numbers, or “no reading”',
          body: 'Ava reads a product’s sign-ups, waitlist, feedback and paying organisations from the product’s own API with plain code, every two hours. So far it is built against one product’s API. A number she could not read says “no reading” and why; it is never shown as 0.',
          status: 'preview',
          you: 'Paste the product’s API token in the workspace; it is kept in the vault.',
        },
        {
          name: 'Three personalities',
          body: 'Growth lead, Positioning and outreach, and Builder in public, in Settings › Personalities. They are inspired by public work and never speak as the person: a draft that names them is refused.',
          status: 'live',
        },
        {
          name: 'Sending and posting what you approve',
          body: 'An approved draft is held. The step that posts or sends it is not built yet, and when it is, each one will still wait for your click.',
          status: 'planned',
        },
      ],
    },
    {
      id: 'models',
      title: 'Models',
      lede: 'Bring your own key, or run everything on your computer.',
      items: [
        {
          name: '10 providers',
          body: 'OpenAI, Anthropic, Gemini, OpenRouter, NVIDIA, DeepSeek, Grok, Azure, Ollama and LM Studio, plus any OpenAI-compatible endpoint.',
          status: 'live',
        },
        {
          name: 'Local, found for you',
          body: 'Ollama and LM Studio are picked up with nothing to set.',
          status: 'live',
        },
        {
          name: 'Local when the cloud fails',
          body: 'Light work moves to a local model when a cloud one is down or over budget.',
          status: 'live',
        },
        {
          name: 'Usage and budgets',
          body: 'Cost and tokens per model, agent and routine, with daily caps.',
          status: 'live',
        },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      lede: 'Built-in connectors, and any MCP server by address. A tool that writes asks first.',
      items: [
        {
          name: 'Built in',
          body: 'GitHub, Linear, Notion, Slack, Gmail, Google Calendar and Google Drive.',
          status: 'live',
        },
        {
          name: 'Any MCP server',
          body: 'Add one by its address, such as Buffer or Figma’s desktop server.',
          status: 'live',
        },
        {
          name: 'WhatsApp Web',
          body: 'Reads which chats are unread in your open WhatsApp Web tab and drafts replies that wait for your click. To talk to Ava herself on WhatsApp, see the WhatsApp group.',
          status: 'preview',
        },
        {
          name: 'Google Drive for recordings',
          body: 'Connect Google Drive and a task’s screen recordings are saved there, private until you press Share. Only tried so far against a stand-in for Google.',
          status: 'preview',
          you: 'Connectors › Google Drive.',
        },
      ],
    },
    {
      id: 'brain',
      title: COMPANION,
      lede: `A small companion on your Mac for what a browser extension can’t do. ${PRODUCT} works fully without it.`,
      items: [
        {
          name: 'Sandboxed code',
          body: 'Runs code for routines and agents in Docker, with no network unless allowed and limits on time and memory.',
          status: 'preview',
        },
        {
          name: 'Routines while the browser is closed',
          body: 'Scheduled work keeps running on your Mac.',
          status: 'preview',
        },
        {
          name: 'Calendar and Obsidian',
          body: 'Reaches the Mac’s Calendar and your Obsidian vault directly.',
          status: 'preview',
        },
        {
          name: 'Your WhatsApp line',
          body: `Holds the link to WhatsApp and hands your messages to ${PRODUCT}. It answers only you.`,
          status: 'preview',
          you: 'Settings › WhatsApp, after pairing Ava Brain.',
        },
        {
          name: 'Ava Keys',
          body: 'A coding agent that speaks MCP (set up for Claude Code today) can ask Ava to run a command with your secrets. You approve each use with Touch ID, and the agent gets the output with every secret replaced by its name. Read the command before you approve it: it can still do anything with the secrets it is given.',
          status: 'preview',
          you: 'Needs a separate secrets vault on the Mac, set up by hand. Approve or deny each request when it appears.',
          on: 'A Touch ID prompt that shows who is asking, why, and the exact command.',
        },
        {
          name: 'Account switching for agents',
          body: 'An agent can ask Ava which GitHub or Vercel account it is working as, and to switch to the right one. It uses the gh-switch and vercel-switch helper scripts, which are not part of Ava and must already be on the Mac. You get a notification on every change.',
          status: 'preview',
          on: 'A notification each time the account changes.',
        },
        { name: 'Public installer', body: 'One command, like the extension’s.', status: 'planned' },
      ],
    },
    {
      id: 'trust',
      title: 'Privacy and updates',
      lede: 'No analytics, no server of ours, and you always know when there is a new version.',
      items: [
        {
          name: 'No analytics',
          body: 'Nothing is measured or reported. Words go only to the model you chose.',
          status: 'live',
        },
        {
          name: 'Your work stays in your browser',
          body: 'Tasks, people, vocabulary and workspaces are kept in your browser, one workspace at a time: a name or a task never carries over to another. Screen recordings go where you choose and are kept out of backups.',
          status: 'live',
        },
        {
          name: 'Keys in a vault',
          body: 'Your keys are kept in an encrypted vault in the browser, never in plain settings.',
          status: 'live',
        },
        {
          name: 'Update notices',
          body: 'Checks this site twice a day; a banner in the panel and one notification per new version, with the update command.',
          status: 'live',
        },
        {
          name: 'Setup checklist',
          body: 'A count on the toolbar until the steps that matter are done.',
          status: 'live',
        },
        {
          name: 'One-click install from a store',
          body: 'A Chrome Web Store listing, so updates arrive by themselves.',
          status: 'planned',
        },
      ],
    },
  ] satisfies FeatureGroup[],
  principlesTitle: 'Rules that never bend',
  principles: [
    'Nothing is sent, posted, bought, deleted or committed without your click. “Allow every time” is a click you made once, and it never covers paying, deleting or giving access.',
    'Workspaces never mix: knowledge, accounts, people, tasks and drafts stay where the request was routed.',
    'Agents draft; you decide. Spending, new accounts and anything that names a customer always ask.',
    'Code it writes runs in a sandbox until you approve it.',
    'No audio leaves your computer before the wake word, and ambient listening stays on it.',
    'Words go only to the model you chose. No analytics, ever.',
  ],
};

// ─── Roadmap ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RoadmapItem {
  name: string;
  body: string;
}

export const roadmap = {
  title: `${PRODUCT} roadmap — what we are building next`,
  description: `What is being built in ${PRODUCT} now, next and later: tasks noted on a call, follow-ups, ambient listening that knows when to speak, agents that send and post through the gate, a Windows installer, a store listing and a desktop app.`,
  ogAlt: `${PRODUCT} roadmap: now, next and later.`,
  breadcrumb: 'Roadmap',
  heading: 'What comes next.',
  lede: 'The order can change when something more useful comes up. Want one sooner? Say so in an issue, or build it.',
  columns: [
    {
      id: 'now',
      title: 'Now',
      items: [
        {
          name: 'Tasks noted on a call',
          body: `Say “${ASSISTANT}, note a task for Sam” in a call and it is on your board.`,
        },
        {
          name: 'Who to chase',
          body: 'Ava tells you who is due a follow-up and drafts the message; you send it.',
        },
        { name: 'Voiceprints', body: `${ASSISTANT} tells your voice from guests and from media, on your computer.` },
        {
          name: 'Windows installer, verified',
          body: 'The PowerShell installer run and fixed on real Windows machines.',
        },
      ],
    },
    {
      id: 'next',
      title: 'Next',
      items: [
        {
          name: 'The scribe',
          body: 'What she hears, split by topic, filed by project, with workspaces created for new projects and a daily note.',
        },
        {
          name: 'A raised hand',
          body: 'Quiet nudges when she has something useful, before she ever speaks unprompted.',
        },
        {
          name: 'Posting through the gate',
          body: 'Scheduled posts on X, LinkedIn, Instagram and YouTube, each waiting for your click.',
        },
        {
          name: 'Agents that send what you approve',
          body: 'Today the growth agents only draft: an approved draft is held. Next, the step that posts or sends it, with the right account checked first and your click on each.',
        },
        { name: 'Set up calls', body: 'Meetings created from the right workspace’s account.' },
        { name: `${COMPANION} installer`, body: 'One command for the Mac companion.' },
      ],
    },
    {
      id: 'later',
      title: 'Later',
      items: [
        { name: 'Learns when to speak', body: 'Comments, reminders and the odd joke, tuned by how you react.' },
        { name: 'Chrome Web Store', body: 'Install with one click, and updates that arrive by themselves.' },
        { name: 'Do it from anywhere', body: 'Every feature by voice without opening the browser, and a desktop app.' },
        {
          name: 'Your own agents for your team',
          body: 'Agents that watch feedback and file issues for your coding tools, never writing the code themselves.',
        },
      ],
    },
  ],
  track: {
    title: 'Ambient listening, step by step',
    lede: 'Ava learns to listen first, and to speak last.',
    steps: [
      { name: 'Listen mode', state: 'done' },
      { name: 'Knows your voice', state: 'now' },
      { name: 'Files talk by project', state: 'next' },
      { name: 'A raised hand', state: 'next' },
      { name: 'Speaks when it’s worth it', state: 'next' },
      { name: 'Learns when to speak', state: 'next' },
    ] as { name: string; state: 'done' | 'now' | 'next' }[],
    stateLabel: { done: 'Shipped', now: 'Building now', next: 'Next' },
  },
  doneTitle: 'Recently built',
  done: [
    {
      date: '2026-11-22',
      text: 'Screen recording for a task, saved to Drive; tasks on WhatsApp; workspaces in one click and sorted for you.',
    },
    {
      date: '2026-11-21',
      text: 'Tasks that tick anywhere, the Tasks page, and people learned from your tools; a typing box with room; words Ava mishears corrected everywhere.',
    },
    {
      date: '2026-11-21',
      text: 'A growth team of three agents with approvals, a budget kept by code, a weekly plan and a daily standup in the brief; check-ups and offers; real product numbers.',
    },
    {
      date: '2026-11-20',
      text: 'Ava knows every open tab; closed tabs come back and failed tasks retry; Allow once or every time; nothing runs twice; Ava Keys.',
    },
    { date: '2026-10-25', text: 'Ambient listening: Listen mode, off the record, forget, always visible.' },
    { date: '2026-10-22', text: 'Update notices in the panel; setup checklist with a toolbar count.' },
    { date: '2026-10-21', text: 'Memory and settings survive an uninstall.' },
    { date: '2026-10-20', text: `${ASSISTANT} speaks in Google Meet as her own participant.` },
    { date: '2026-10-19', text: 'A local model takes over when the cloud fails; private and team memory for agents.' },
  ],
};

// ─── Changelog ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The page's own words. The entries come from the repository's CHANGELOG.md (src/lib/changelog.ts). */
export const changelogPage = {
  title: `${PRODUCT} changelog — what changed, week by week`,
  description: `What changed in ${PRODUCT}, newest first, in plain words: each line says what is different for you and links the change on GitHub.`,
  ogAlt: `${PRODUCT} changelog: what changed, week by week.`,
  breadcrumb: 'Changelog',
  heading: 'What changed.',
  lede: (version: string, hasNext: boolean) =>
    `Newest first, in plain words, each line linked to the change on GitHub.${
      hasNext
        ? ` The download on the install page is version ${version}; entries marked next release are merged and arrive with the next one.`
        : ''
    }`,
};

// ─── Contribute ────────────────────────────────────────────────────────────────────────────────────────────────────

export const contribute = {
  title: `Contribute to ${PRODUCT} — code, translations, skills and testing`,
  description: `How to help build ${PRODUCT}: set it up locally, the rules every change follows, where help is wanted most, and how to report a bug or a security issue.`,
  ogAlt: `Contribute to ${PRODUCT}.`,
  breadcrumb: 'Contribute',
  heading: 'Build it with us.',
  lede: 'Code is one way in. Testing on your machine, translating, writing skills for the sites you use and reporting bugs help just as much.',
  ways: [
    {
      id: 'code',
      title: 'Write code',
      body: 'Pick an issue marked good first issue, or a Planned feature from the list.',
      icon: 'code',
    },
    {
      id: 'test',
      title: 'Test it',
      body: 'Install it on your machine and browser, and tell us what broke. Windows testers are wanted most.',
      icon: 'test',
    },
    {
      id: 'translate',
      title: 'Translate',
      body: 'The app ships in English, Portuguese (Brazil) and Traditional Chinese. Add or improve a language.',
      icon: 'translate',
    },
    {
      id: 'skills',
      title: 'Write skills',
      body: 'A skill is a Markdown playbook for a site or task. If you use a site every day, you know its route best.',
      icon: 'skills',
    },
    {
      id: 'report',
      title: 'Report a problem',
      body: 'The issue form asks for what a fixer needs. In the extension: Settings › Help › Report a problem.',
      icon: 'report',
    },
    {
      id: 'share',
      title: 'Tell people',
      body: 'A post, a video or a word to a friend who lives in the browser.',
      icon: 'share',
    },
  ],
  setupTitle: 'Run it locally',
  setupLede: 'Node.js 24 and pnpm 10. About five minutes.',
  setupSteps: [
    { title: 'Get the code', command: `git clone ${REPO}.git && cd ava-copilot` },
    { title: 'Install', command: 'corepack enable && pnpm install' },
    { title: 'Build and watch', command: 'pnpm dev' },
    {
      title: 'Load it',
      text: 'Open your browser’s extensions page, switch on Developer mode, click Load unpacked and choose the dist folder.',
    },
    { title: 'Check your change', command: 'pnpm type-check && pnpm test' },
  ],
  stackTitle: 'How it is built',
  stack: [
    {
      name: 'Extension',
      text: 'WXT, Manifest V3, React and TypeScript. The background owns all state; the panel only reads and sends commands.',
    },
    { name: 'Data', text: 'IndexedDB through Dexie, in the browser. No server of ours.' },
    { name: 'Models', text: 'The Vercel AI SDK, so every provider is one adapter.' },
    { name: 'Voice', text: 'Moonshine, Whisper, Vosk, KittenTTS and Kokoro in workers in an offscreen document.' },
    {
      name: COMPANION,
      text: 'A Node service on the Mac (companion/), with agent sessions on Vercel eve and Docker sandboxes.',
    },
    { name: 'Website', text: 'This site: Astro, in site/. Static pages, no third-party scripts.' },
  ],
  rulesTitle: 'Rules every change follows',
  rules: [
    {
      title: 'The gate stays',
      text: 'Anything that sends, posts, submits, deletes, publishes, buys or changes permissions goes through the review gate. No exceptions: the only way past a card is a click on it, or a rule the user saved with a click.',
    },
    {
      title: 'Outside text is data',
      text: 'Pages, messages, transcripts and tool output never become instructions. Wrap them as untrusted content before a model sees them.',
    },
    {
      title: 'No analytics, no new hosts',
      text: 'Nothing calls anyone but the model the user chose. A new permission or host is called out in the pull request.',
    },
    {
      title: 'New features in new folders',
      text: 'Plug in through the registries (register.ts) and keep edits to upstream Nanobrowser files small, so merges stay possible.',
    },
    { title: 'Every string in every language', text: 'A new message key goes into every locale in public/_locales.' },
    {
      title: 'Tests with the change',
      text: 'Unit tests next to the code, and an end-to-end test for anything the user sees. Lint only the files you changed.',
    },
  ],
  flowTitle: 'From a report to a fix',
  flow: [
    'Someone reports a problem through the issue form (in the extension: Settings › Help › Report a problem).',
    'Pick it up: comment “I’ll take this” so nobody doubles up. Reporters are welcome to fix their own issue.',
    'Fork, branch, fix. One change per pull request, against feat/restyle, with “Fixes #123” in the description.',
    'CI checks types, tests, locales and both builds on every pull request. A maintainer reviews within a few days.',
  ],
  toolsTitle: 'Tools that make it quick',
  toolsLede:
    'Use whatever you like. These work well with this codebase; the repository’s AGENTS.md tells coding agents the rules.',
  tools: [
    {
      name: 'Claude Code',
      text: 'A coding agent in your terminal. Give it the issue link; it reads AGENTS.md and the docs first.',
    },
    {
      name: 'Cursor or VS Code',
      text: 'An editor with an AI assistant. Open the repo and point it at the issue and the files it names.',
    },
    { name: 'Codex CLI', text: 'OpenAI’s terminal agent, if that is the one you use.' },
    {
      name: 'GitHub CLI',
      text: '`gh issue list --label "good first issue"` to find one, `gh pr create` to send your fix.',
    },
    {
      name: 'github.dev',
      text: 'Press . on any GitHub page to edit in the browser: enough for copy, docs and translations.',
    },
  ],
  toolsNote: 'Suggestions, not endorsements. Whatever you use, run pnpm type-check and pnpm test before you push.',
  securityTitle: 'Found a security problem?',
  securityBody:
    'Please don’t open a public issue. Report it privately through a GitHub security advisory, and we will answer within three days.',
  securityLink: 'Report privately',
  licenseNote: `${PRODUCT} is free for personal use under PolyForm Noncommercial 1.0.0; the parts from Nanobrowser stay Apache-2.0. Sign off each commit (git commit -s) to certify the Developer Certificate of Origin and let the owner license your work under the same or other terms.`,
};

// ─── Donate ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DonationChannel {
  id: string;
  name: string;
  body: string;
  // Null until the account exists: the card shows "Opening soon" and no link
  url: string | null;
  // A simple-icons slug for the platform's mark, when it has one
  mark: string | null;
}

export const donate = {
  title: `Support ${PRODUCT} — keep it free, local and open`,
  description: `${PRODUCT} is free for personal use, with public code, no ads and no analytics. Donations pay for testing models, signing the Mac companion and a store listing.`,
  ogAlt: `Support ${PRODUCT}.`,
  breadcrumb: 'Donate',
  heading: 'Keep it free.',
  lede: `${PRODUCT} has no ads, no analytics and no paid plan, and it never will. Donations keep it that way.`,
  notOpen:
    'Donations aren’t open yet. The ways below go live once the accounts are set up; nothing here takes money today.',
  soon: 'Opening soon',
  channels: [
    {
      id: 'sponsors',
      name: 'GitHub Sponsors',
      body: 'Monthly or one-time, through your GitHub account.',
      url: null,
      mark: 'githubsponsors',
    },
    {
      id: 'opencollective',
      name: 'Open Collective',
      body: 'Every expense in the open, for companies that need an invoice.',
      url: null,
      mark: 'opencollective',
    },
    { id: 'once', name: 'One-time gift', body: 'A single donation by card.', url: null, mark: null },
  ] satisfies DonationChannel[],
  usesTitle: 'Where it goes',
  uses: [
    { name: 'Model testing', text: 'Running every change against the cloud and local models people actually use.' },
    { name: 'Signing and notarising', text: `An Apple developer account, so ${COMPANION} installs without warnings.` },
    { name: 'Store listings', text: 'The Chrome Web Store and Edge Add-ons, so updates arrive by themselves.' },
    { name: 'Test machines', text: 'Windows and Linux machines to test the installers on.' },
  ],
  otherTitle: 'Other ways to help',
  other: [
    { label: 'Contribute', href: projectLinks.contribute },
    { label: 'Report a problem', href: projectLinks.newIssue },
    { label: 'See the roadmap', href: projectLinks.roadmap },
  ],
};

// ─── Feature pages and the nav ─────────────────────────────────────────────────────────────────────────────────────

/** Each group's line in the nav and on the hub, and the widget its page shows. */
export const groupMeta: Record<string, { short: string; widget: string }> = {
  browser: { short: 'Plans, clicks and types, in the tabs you have', widget: 'trail' },
  gate: { short: 'Nothing commits without your click', widget: 'gate' },
  tasks: { short: 'One board, ticked anywhere, and who is who', widget: '' },
  voice: { short: '“Hey Ava”, on your computer', widget: 'voice' },
  ambient: { short: 'Listens, notes, speaks when it’s worth it', widget: 'ambient' },
  meetings: { short: 'Notes for Google Meet from the first minute', widget: 'meeting' },
  whatsapp: { short: 'Message Ava from your phone', widget: '' },
  memory: { short: 'Answers with the source', widget: 'graph' },
  workspaces: { short: 'One per project, never mixed', widget: 'workspaces' },
  automation: { short: 'Routines, agents and an Inbox', widget: 'routine' },
  team: { short: 'Agents that draft; you decide', widget: '' },
  models: { short: 'Your key, or fully local', widget: 'models' },
  integrations: { short: 'GitHub, Slack, Drive and any MCP', widget: 'integrations' },
  brain: { short: 'A Mac companion: sandbox, WhatsApp, keys', widget: 'brain' },
  trust: { short: 'No analytics, and update notices', widget: 'trust' },
};

export const featureHref = (id: string) => `/features/${id}`;

/** The features hub's way in by what a person wants to do: each line names the groups that answer it. */
export const featurePaths = {
  title: 'Find it by what you want to do',
  items: [
    { title: 'Work in my browser', body: 'Tabs, forms, retries.', ids: ['browser', 'workspaces'] },
    {
      title: 'Keep track of tasks and people',
      body: 'The board, the Tasks page, who is who.',
      ids: ['tasks', 'memory'],
    },
    {
      title: 'Take a call, talk to Ava',
      body: 'Meeting notes, voice, listening.',
      ids: ['meetings', 'voice', 'ambient'],
    },
    { title: 'Use Ava from my phone', body: 'Message her, ask for tasks.', ids: ['whatsapp'] },
    { title: 'Have a team work for me', body: 'Routines, the Inbox, growth agents.', ids: ['automation', 'team'] },
    { title: 'Stay in control', body: 'The click, rules, privacy.', ids: ['gate', 'trust'] },
    {
      title: 'Connect and set up',
      body: 'Models, tools, the Mac companion.',
      ids: ['models', 'integrations', 'brain'],
    },
  ],
};

export interface MenuLink {
  href: string;
  label: string;
  note?: string;
  icon: string;
}

export interface Menu {
  id: string;
  label: string;
  href: string;
  featured: { title: string; body: string; href: string; action: string; widget: 'gate' | 'install' | 'community' };
  columns: { title: string; links: MenuLink[] }[];
}

const MENU_WORK = ['browser', 'tasks', 'workspaces', 'memory', 'meetings', 'voice', 'ambient', 'whatsapp'];
const MENU_SETUP = ['gate', 'automation', 'team', 'models', 'integrations', 'brain', 'trust'];
const groupsIn = (ids: string[]) => ids.flatMap(id => features.groups.filter(group => group.id === id));

const linkFor = (group: FeatureGroup): MenuLink => ({
  href: featureHref(group.id),
  label: group.title,
  note: groupMeta[group.id]?.short,
  icon: group.id,
});

export const menus: Menu[] = [
  {
    id: 'product',
    label: 'Product',
    href: projectLinks.features,
    featured: {
      title: 'The gate',
      body: 'It does the work and stops at the point of no return. Try to skip the click.',
      href: featureHref('gate'),
      action: 'See it work',
      widget: 'gate',
    },
    columns: [
      { title: 'Does the work', links: groupsIn(MENU_WORK).map(linkFor) },
      { title: 'Runs your setup', links: groupsIn(MENU_SETUP).map(linkFor) },
    ],
  },
  {
    id: 'start',
    label: 'Get started',
    href: '/install',
    featured: {
      title: 'Two minutes, no account',
      body: 'One command downloads it; you turn it on in your browser once.',
      href: '/install',
      action: 'Install',
      widget: 'install',
    },
    columns: [
      {
        title: 'Install',
        links: [
          { href: '/install', label: 'Install', note: 'Brave, Chrome and Edge', icon: 'download' },
          {
            href: '/install#notify',
            label: 'Updates and notices',
            note: 'How you hear about new versions',
            icon: 'bell',
          },
          { href: '/install#connect', label: 'Connect', note: 'WhatsApp, Drive and Ava Brain', icon: 'blocks' },
          { href: '/install#brain', label: COMPANION, note: 'The optional Mac companion', icon: 'brain' },
        ],
      },
      {
        title: 'Learn more',
        links: [
          { href: projectLinks.features, label: 'All features', note: 'Live, preview and planned', icon: 'grid' },
          { href: projectLinks.roadmap, label: 'Roadmap', note: 'What comes next', icon: 'map' },
          { href: projectLinks.changelog, label: 'Changelog', note: 'What changed, week by week', icon: 'history' },
          { href: '/privacy', label: 'Privacy', note: 'What leaves your computer', icon: 'shield' },
          { href: projectLinks.releasesFeed, label: 'Release feed', note: 'RSS for every version', icon: 'rss' },
        ],
      },
    ],
  },
  {
    id: 'community',
    label: 'Community',
    href: projectLinks.contribute,
    featured: {
      title: 'Free for personal use, built in the open',
      body: 'The code is public and contributions are welcome. Code, testing, translations and skills all count.',
      href: projectLinks.contribute,
      action: 'Contribute',
      widget: 'community',
    },
    columns: [
      {
        title: 'Take part',
        links: [
          { href: projectLinks.contribute, label: 'Contribute', note: 'Ways to help and local setup', icon: 'code' },
          {
            href: projectLinks.newIssue,
            label: 'Report a problem',
            note: 'A GitHub issue anyone can fix',
            icon: 'bug',
          },
          { href: '/contribute#security', label: 'Security', note: 'Report a problem privately', icon: 'shieldAlert' },
        ],
      },
      {
        title: 'Support',
        links: [
          { href: projectLinks.donate, label: 'Donate', note: 'Keep it free', icon: 'heart' },
          {
            href: 'https://github.com/nanobrowser/nanobrowser',
            label: 'Nanobrowser',
            note: 'The project it forks',
            icon: 'gitFork',
          },
        ],
      },
    ],
  },
];

// ─── The feature pages' own widgets ────────────────────────────────────────────────────────────────────────────────

/** What to try in each group's widget, beside it on the page. */
export const tryHints: Record<string, string[]> = {
  browser: ['Watch the run reach the sign-in and hand it back.', 'Press Stop at any step.'],
  gate: ['Try to send without holding the button.', 'Let go early: nothing is sent.'],
  voice: ['Press Talk and watch it listen, think and answer.', 'All of it can run on your computer.'],
  ambient: ['Switch on Off the record: the lines stop.', 'Press Forget 10 min: they are gone everywhere.'],
  meetings: ['Watch the captions turn into a note.', 'Tick off an action item.'],
  memory: ['Point at a node to see what it links to.', 'Every answer cites where it came from.'],
  workspaces: ['Switch workspace: the accounts and knowledge change with it.', 'Nothing carries over.'],
  automation: ['Press Run now and watch it stop at the post.', 'Answer the Inbox card.'],
  models: ['Pick a model and see where the words go.', 'Local models never leave your computer.'],
  integrations: ['Built-in connectors, and any MCP server by address.', 'A tool that writes asks first.'],
  brain: ['Run the tests in the sandbox.', 'Nothing reaches your Mac until you approve it.'],
  trust: ['This is the banner the panel shows when a new version is out.', 'One notification per version.'],
};

export const widgetCopy = {
  ambient: {
    title: 'Listening on this Mac',
    offRecordTitle: 'Off the record',
    offRecordNote: 'Nothing is written down until you switch it back.',
    switchLabel: 'Off the record',
    forget: 'Forget 10 min',
    forgot: 'Forgotten here and in your memory.',
    replay: 'Play again',
    local: 'Transcribed by the recogniser on this Mac. Nothing leaves it.',
    lines: [
      { at: '14:02', text: 'So the launch moves to Friday?' },
      { at: '14:02', text: 'Friday, yes. The page is ready, only the photos are left.' },
      { at: '14:03', text: 'I’ll send Sam the brief tonight.' },
      { at: '14:04', text: 'And we still need a date for the venue.' },
      { at: '14:05', text: 'Let’s look at the venue list after lunch.' },
    ],
  },
  meeting: {
    call: 'Weekly sync · Google Meet',
    live: 'Taking notes',
    captionsLabel: 'Captions',
    noteLabel: 'Note',
    replay: 'Play again',
    captions: [
      { who: 'Sam', text: 'Can we ship the landing page this week?' },
      { who: 'You', text: 'Yes, if the copy is final by Wednesday.' },
      { who: 'Jo', text: 'I’ll have the copy done Tuesday.' },
      { who: 'You', text: 'Great, then we launch Thursday morning.' },
    ],
    summary: 'The landing page launches Thursday morning, once the copy is final.',
    decisionsLabel: 'Decided',
    decisions: ['Launch Thursday morning'],
    actionsLabel: 'Action items',
    actions: [
      { who: 'Jo', text: 'Final copy by Tuesday' },
      { who: 'You', text: 'Schedule the launch post' },
    ],
  },
  workspaces: {
    label: 'Workspace',
    accountsLabel: 'Accounts it acts as',
    knowledgeLabel: 'What it knows here',
    note: 'Switching never carries knowledge, accounts or drafts across.',
    items: [
      {
        id: 'studio',
        name: 'Studio',
        accounts: ['Google · work', 'Slack · Studio', 'X · @studio'],
        knowledge: ['Pricing decision · Oct 12', 'Client call notes · Oct 20', 'Q4 hiring plan'],
      },
      {
        id: 'meetup',
        name: 'City meetup',
        accounts: ['Google · meetup', 'Instagram · @citymeetup', 'LinkedIn · City meetup'],
        knowledge: ['Venue shortlist', 'Speaker emails · Oct 18', 'Sponsor deck v3'],
      },
      {
        id: 'charity',
        name: 'Charity',
        accounts: ['Google · charity', 'X · @charity'],
        knowledge: ['Launch page copy', 'Grant application notes', 'Board meeting · Oct 9'],
      },
    ],
  },
  brain: {
    title: 'Sandbox · tests for the new routine',
    command: 'pnpm test',
    limits: ['No network', '1 CPU', '512 MB', '60 s limit', 'Own folder only'],
    run: 'Run in sandbox',
    running: 'Running…',
    lines: ['Installing from the lockfile', 'Running 24 tests', '24 passed'],
    result: 'Done in the sandbox. Nothing has touched your Mac.',
    approve: 'Approve to apply',
    approved: 'Applied after your click',
  },
  update: {
    title: 'Update available',
    version: 'Version 0.2.5',
    notes: ['One conversation per tab', 'Auto mode, hover and retry countdowns'],
    commandLabel: 'Run this, then reload:',
    reload: 'Reload',
    later: 'Later',
  },
};

// ─── Link-preview cards (rendered by src/pages/og-card/[slug].astro into /og/<slug>.png) ──────────────────────

export const ogCards: Record<string, { kicker: string; title: [string, string]; group?: string }> = {
  features: { kicker: 'Features', title: ['Everything it does,', 'marked as it really is.'] },
  roadmap: { kicker: 'Roadmap', title: ['What comes next.', 'Listen first, speak last.'] },
  changelog: { kicker: 'Changelog', title: ['What changed,', 'week by week.'] },
  contribute: { kicker: 'Contribute', title: ['Build it with us.', 'Code, tests, skills and words.'] },
  donate: { kicker: 'Donate', title: ['Keep it free.', 'No ads, no analytics, ever.'] },
  ...Object.fromEntries(
    features.groups.map(group => [
      `feature-${group.id}`,
      {
        kicker: 'Features',
        title: [`${group.title}.`, `${groupMeta[group.id]?.short ?? ''}.`] as [string, string],
        group: group.id,
      },
    ]),
  ),
};
