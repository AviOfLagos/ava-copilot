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
export const REPO = 'https://github.com/AviOfLagos/nex-copilot';

export const projectLinks = {
  features: '/features',
  roadmap: '/roadmap',
  contribute: '/contribute',
  donate: '/donate',
  repo: REPO,
  issues: `${REPO}/issues`,
  newIssue: `${REPO}/issues/new`,
  discussions: `${REPO}/discussions`,
  security: `${REPO}/security/advisories/new`,
  contributing: `${REPO}/blob/feat/restyle/CONTRIBUTING.md`,
  releasesFeed: '/releases.xml',
};

// ─── Features ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Feature {
  name: string;
  body: string;
  status: Status;
}

export interface FeatureGroup {
  id: string;
  title: string;
  lede: string;
  items: Feature[];
}

export const features = {
  title: `Every feature of ${PRODUCT} — what ships today and what is next`,
  description: `The full list of what ${PRODUCT} does: it works on real pages, talks, takes meeting notes, remembers, runs routines and agents, listens around you, and works with any model. Each feature is marked live, preview or planned.`,
  ogAlt: `${PRODUCT}: every feature, marked live, preview or planned.`,
  breadcrumb: 'Features',
  heading: 'Everything it does.',
  lede: `Each feature is marked as it really is today. ${ASSISTANT} is the assistant you talk to; ${PRODUCT} is the extension she lives in.`,
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
      title: 'Works on real pages',
      lede: 'Ask in plain words. It plans, clicks and types on the pages you already use, and shows every step.',
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
      lede: 'Nothing is sent, posted, bought, deleted or committed without your click. No setting turns that off.',
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
          body: '“Set up a call with Tolu” creates it from the right workspace’s Google account.',
          status: 'planned',
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
          body: 'Every morning: your calendar, open threads and what to do first, by workspace.',
          status: 'live',
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
        { name: 'WhatsApp', body: `Reads and drafts in WhatsApp Web, or through ${COMPANION}.`, status: 'preview' },
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
    'Nothing is sent, posted, bought, deleted or committed without your click.',
    'Workspaces never mix: knowledge, accounts and drafts stay where the request was routed.',
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
  description: `What is being built in ${PRODUCT} now, next and later: ambient listening that knows when to speak, posting through the gate, a Windows installer, a store listing and a desktop app.`,
  ogAlt: `${PRODUCT} roadmap: now, next and later.`,
  breadcrumb: 'Roadmap',
  heading: 'What comes next.',
  lede: 'The order can change when something more useful comes up. Want one sooner? Say so in an issue, or build it.',
  columns: [
    {
      id: 'now',
      title: 'Now',
      items: [
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
  doneTitle: 'Recently shipped',
  done: [
    { date: '2026-10-25', text: 'Ambient listening: Listen mode, off the record, forget, always visible.' },
    { date: '2026-10-22', text: 'Update notices in the panel; setup checklist with a toolbar count.' },
    { date: '2026-10-21', text: 'Memory and settings survive an uninstall.' },
    { date: '2026-10-20', text: `${ASSISTANT} speaks in Google Meet as her own participant.` },
    { date: '2026-10-19', text: 'A local model takes over when the cloud fails; private and team memory for agents.' },
  ],
};

// ─── Contribute ────────────────────────────────────────────────────────────────────────────────────────────────────

export const contribute = {
  title: `Contribute to ${PRODUCT} — code, translations, skills and testing`,
  description: `How to help build ${PRODUCT}: set it up locally, the rules every change follows, where help is wanted most, and how to report a bug or a security issue.`,
  ogAlt: `Contribute to ${PRODUCT}.`,
  breadcrumb: 'Contribute',
  heading: 'Build it with us.',
  lede: 'Code is one way in. Testing on your machine, translating, writing skills for the sites you use and reporting bugs help just as much.',
  repoNote: 'The repository opens to the public soon. Until then, message @AviOfLagos on GitHub for access.',
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
      title: 'Report a bug',
      body: 'What you did, what you expected, what happened, and your browser and system.',
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
    { title: 'Get the code', command: `git clone ${REPO}.git && cd nex-copilot` },
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
      text: 'Anything that sends, posts, submits, deletes, publishes, buys or changes permissions goes through the review gate. No exceptions, no settings to skip it.',
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
  flowTitle: 'From idea to merged',
  flow: [
    'Open an issue first for anything bigger than a fix, so we agree on the shape before you spend the time.',
    'One change per pull request, on its own branch, against feat/restyle.',
    'Say what you tested and how. Screenshots for anything visual.',
    'A maintainer reviews within a few days. Small, focused pull requests merge fastest.',
  ],
  securityTitle: 'Found a security problem?',
  securityBody:
    'Please don’t open a public issue. Report it privately through a GitHub security advisory, and we will answer within three days.',
  securityLink: 'Report privately',
  licenseNote: `${PRODUCT} is Apache-2.0, a fork of Nanobrowser. By contributing you agree your work is shared under the same licence.`,
};

// ─── Donate ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DonationChannel {
  id: string;
  name: string;
  body: string;
  // Null until the account exists: the card shows "Opening soon" and no link
  url: string | null;
}

export const donate = {
  title: `Support ${PRODUCT} — keep it free, local and open`,
  description: `${PRODUCT} is free and open source with no ads and no analytics. Donations pay for testing models, signing the Mac companion and a store listing.`,
  ogAlt: `Support ${PRODUCT}.`,
  breadcrumb: 'Donate',
  heading: 'Keep it free.',
  lede: `${PRODUCT} has no ads, no analytics and no paid plan, and it never will. Donations keep it that way.`,
  notOpen:
    'Donations aren’t open yet. The ways below go live once the accounts are set up; nothing here takes money today.',
  soon: 'Opening soon',
  channels: [
    { id: 'sponsors', name: 'GitHub Sponsors', body: 'Monthly or one-time, through your GitHub account.', url: null },
    {
      id: 'opencollective',
      name: 'Open Collective',
      body: 'Every expense in the open, for companies that need an invoice.',
      url: null,
    },
    { id: 'once', name: 'One-time gift', body: 'A single donation by card.', url: null },
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
    { label: 'Report a bug', href: projectLinks.newIssue },
    { label: 'See the roadmap', href: projectLinks.roadmap },
  ],
};
