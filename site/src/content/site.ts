/*
 * The content model: every word the site shows lives here, and components only read from it.
 * Strings the extension itself shows (the gate's kinds, the run trail's labels, the panel's footer) are read from
 * the app's own locale through `t()`, so the demo always says what the product says.
 */
import { t } from '@extension/i18n';
import { version } from '../../../package.json';

/** The product's public name, in one place: a rename is this line. */
export const PRODUCT = 'Avi Copilot';
export const COMPANION = 'Avi Brain';

/** Absolute origin, from SITE_URL at build time (astro.config.mjs), without a trailing slash. */
export const SITE_URL = import.meta.env.SITE.replace(/\/+$/, '');
export const INSTALL_SCRIPT_PATH = '/install.sh';
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}${INSTALL_SCRIPT_PATH} | bash`;
/** The same command with options for the script, e.g. `--with-voices`. */
export const installCommandWith = (options: string) => `${INSTALL_COMMAND} -s -- ${options}`;
export const VERSION = version;

export const links = {
  home: '/',
  install: '/install',
  privacy: '/privacy',
  installScript: INSTALL_SCRIPT_PATH,
  releases: '/download/avi-copilot-latest.zip',
  upstream: 'https://github.com/nanobrowser/nanobrowser',
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
};

export const product = {
  name: PRODUCT,
  tagline: 'The AI browser copilot that waits for your click',
  description: `${PRODUCT} is an AI copilot in your browser’s side panel. It works on real pages, takes meeting notes, talks, remembers what you saw and runs routines, with the model you choose. Nothing is sent, posted, bought or deleted without your click.`,
  browsers: ['Brave', 'Chrome', 'Edge'],
  systems: ['macOS', 'Linux', 'Windows'],
  license: 'Apache-2.0',
  upstream: 'Nanobrowser',
};

export const nav = {
  label: 'Main',
  skip: 'Skip to content',
  home: `${PRODUCT}, home`,
  items: [
    { href: '/#gate', label: 'How it works' },
    { href: links.privacy, label: 'Privacy' },
  ],
  install: 'Install',
};

export const theme = {
  label: 'Theme',
  options: [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ],
};

export const copy = {
  idle: 'Copy',
  done: 'Copied',
  announce: 'Command copied to the clipboard',
  failed: 'Select the command and copy it',
};

export const footer = {
  lineage: `${PRODUCT} is a fork of Nanobrowser, the open-source browser agent, under the Apache License 2.0.`,
  upstreamLabel: 'Nanobrowser on GitHub',
  licenseLabel: 'Apache License 2.0',
  privacyNote: 'This site sets no cookies and loads nothing from anyone else.',
  version: `Version ${VERSION}`,
  columns: [
    {
      title: 'Product',
      links: [
        { href: '/#gate', label: 'The gate' },
        { href: '/#models', label: 'Models' },
        { href: '/#voice', label: 'Voice and meetings' },
        { href: '/#faq', label: 'Questions' },
      ],
    },
    {
      title: 'Get it',
      links: [
        { href: links.install, label: 'Install' },
        { href: `${links.install}#update`, label: 'Update or remove' },
        { href: `${links.install}#brain`, label: COMPANION },
        { href: links.privacy, label: 'Privacy' },
      ],
    },
  ],
};

// ─── Home ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Written out in full so the build can find these keys in the app's locale
const GATE_KINDS = [
  'gate_kind_send',
  'gate_kind_publish',
  'gate_kind_submit',
  'gate_kind_delete',
  'gate_kind_purchase',
  'gate_kind_permission',
];

export const home = {
  title: `${PRODUCT} — the AI browser copilot that waits for your click`,
  description: `${PRODUCT} works in the side panel of Brave, Chrome and Edge: it does tasks on real pages, takes meeting notes and remembers what you saw, with your own model. Nothing is sent, posted, bought or deleted without your click.`,
  ogAlt: `${PRODUCT}: a side panel that drafted a reply and waits on an amber “Hold to send” button.`,
  hero: {
    eyebrow: 'For Brave, Chrome and Edge · Free · No account',
    title: 'The AI browser copilot that waits for your click.',
    lede: `${PRODUCT} works in your browser’s side panel. It reads pages, clicks, types and fills in forms on any site, takes meeting notes and remembers what you saw. Before anything is sent, posted, bought or deleted, it stops and waits for you.`,
    installLabel: 'Install on macOS or Linux',
    installNote: 'Then turn it on in Brave, Chrome or Edge.',
    windows: { href: `${links.install}#windows`, label: 'On Windows? Install by hand' },
    guide: { href: links.install, label: 'Read the install guide' },
    facts: [
      'Your model, your key, or fully local',
      'No analytics, no server of ours',
      'Built on Nanobrowser, Apache-2.0',
    ],
  },
  gate: {
    id: 'gate',
    kicker: 'The gate',
    title: 'It drafts. You decide what leaves.',
    body: [
      'Sending, posting, submitting, deleting, publishing, buying and sharing all stop at an amber card. It shows the page, the button it is about to press and the words it read back from that page.',
      'Hold the button for under a second, or click it twice. The friction is the point. Stop, and nothing is sent.',
    ],
    kindsLabel: 'Stops before it can',
    kinds: GATE_KINDS.map(key => t(key)),
    points: [
      {
        title: 'Your sign-ins stay yours',
        body: 'Logins, CAPTCHAs and one-time codes are handed back to you. It never types a password.',
      },
      {
        title: 'Pages are data, not orders',
        body: `Instructions hidden in a page are ignored, and it tells you: “${t('gate_injection_ignored')}”`,
      },
      {
        title: 'Checked afterwards',
        body: 'After a send it reads the page again and says whether your message is really there.',
      },
    ],
  },
  trail: {
    id: 'steps',
    kicker: 'Every step in view',
    title: 'You can see what it is doing, and stop it.',
    body: [
      'Each task draws itself as a short chain: read, searched, clicked, typed. The wire fills as steps finish, so one glance tells you where it is.',
      'It asks when it needs you, fills a whole form in one pass and asks what it couldn’t find in one card. You can stop it or take over at any step. Several chats can run at once, each kept to its own tabs.',
    ],
    example: {
      label: 'A form, in one pass',
      steps: [
        { icon: 'navigate', label: 'Opened the offsite sign-up form' },
        { icon: 'read', label: 'Read all 9 fields at once' },
        { icon: 'type', label: 'Filled 7 from your notes and calendar' },
        { icon: 'note', label: t('gate_formQuestionsAnswered') },
      ],
      held: t('chat_run_held', [t('gate_kind_submit')]),
      heldDetail: 'Submit',
    },
  },
  models: {
    id: 'models',
    kicker: 'Models',
    title: 'Your model, your key, or fully local.',
    body: 'No subscription and no account. Bring a key for a cloud model or run one on your own computer, and pick a different model per chat. Keys are kept encrypted in your browser and go only to their own provider.',
    groups: [
      { label: 'On your computer', kind: 'local', items: ['Ollama', 'LM Studio'] },
      {
        label: 'In the cloud, with your key',
        kind: 'cloud',
        items: ['OpenRouter', 'NVIDIA NIM', 'OpenAI', 'Anthropic', 'Google Gemini', 'xAI', 'DeepSeek', 'Azure OpenAI'],
      },
    ],
    notes: [
      { title: 'A daily spending cap', body: 'It starts at five dollars a day, with usage by day, model and agent.' },
      {
        title: 'Voices that cost nothing',
        body: 'KittenTTS and Kokoro speak, Moonshine and Whisper listen, all on your computer.',
      },
    ],
  },
  voice: {
    id: 'voice',
    kicker: 'Voice and meetings',
    title: 'Talk to it. Let it take the notes.',
    body: [
      'Say “Hey Ava”. The wake word is recognised on your computer, and nothing is heard by anyone until it fires.',
      'Talk through Gemini Live, or in economy mode, where your words are written down on your computer and only text goes to your model. Or dictate into the chat box and edit before you send.',
      'In a call on Meet, Zoom or Teams in the browser, it keeps a live transcript and a rolling summary, then writes the note: decisions, action items with owners and dates, open questions.',
    ],
    stage: {
      talkLabel: 'Talk',
      wake: '“Hey Ava”',
      wakeNote: 'The wake word is recognised on this computer.',
      orbLabel: `${PRODUCT}’s voice orb`,
      dictateLabel: 'Dictate',
      words: 'Draft follow-ups from this morning’s call.',
      placeholder: 'Ask, or press the mic',
      sentNote: 'In the panel, this goes to your copilot.',
      replay: 'Press the mic to dictate again.',
    },
  },
  memory: {
    id: 'memory',
    kicker: 'Memory',
    title: 'It remembers what you saw, and shows you where.',
    body: [
      'Chats, meeting notes and pages you save become one searchable memory. Ask what was decided and the answer cites the meeting and the minute; a click opens the transcript at that line.',
      'People, projects and decisions are linked in a graph you can open. Each workspace keeps its own memory, and they never mix.',
    ],
    graphLabel:
      'A small part of a knowledge graph: a project linked to a meeting, a decision, a person, a chat and a saved page.',
    question: 'What did we decide about pricing?',
    answer: 'Free for now, and look again in January.',
    sources: ['Mon call · 14:12', 'Chat · Launch plan'],
    nodes: {
      project: 'Pricing',
      meeting: 'Mon call',
      decision: 'Free for now',
      person: 'Maya',
      chat: 'Launch plan',
      page: 'Q3 plan',
    },
  },
  routines: {
    id: 'routines',
    kicker: 'Routines and helper agents',
    title: 'Work that runs on its own, and still asks first.',
    body: [
      'Describe a routine in a sentence. It is drawn as a diagram and runs on its schedule once you click Create.',
      'Helper agents watch the sites you name and work in a window of their own, within a budget. Whatever would send or post waits in your Inbox.',
      'Connect GitHub, Linear, Notion, Slack or Google through MCP. A new or changed tool stays off until you choose.',
    ],
    diagramLabel:
      'A routine drawn as a diagram: every weekday at 8:00 it searches tech news, summarises it into the morning brief, and waits for your click before posting to the team channel.',
    nodes: [
      { kind: 'Schedule', title: 'Every weekday at 8:00', icon: 'clock' },
      { kind: 'Web search', title: 'Search tech news', icon: 'search' },
      { kind: 'Model', title: 'Summarise in five lines', icon: 'sparkles' },
      { kind: 'Brief', title: 'Add to the morning brief', icon: 'brief' },
    ],
    held: { kind: 'Connector', title: 'Post to #team', note: 'Waits for your click' },
  },
  privacy: {
    id: 'privacy-label',
    kicker: 'Privacy',
    title: 'Your data stays where you put it.',
    body: 'There is no server of ours to send anything to. What does leave goes where you pointed it, and only when a task needs it.',
    more: { href: links.privacy, label: 'Read the privacy details' },
  },
  faq: {
    id: 'faq',
    kicker: 'Questions',
    title: 'Before you install.',
    items: [
      {
        q: 'Is it free?',
        a: `Yes. ${PRODUCT} costs nothing and needs no account. You pay your model provider for what you use, or nothing if you run a model on your own computer.`,
      },
      {
        q: 'Which browsers and systems does it work on?',
        a: 'Brave, Google Chrome and Microsoft Edge, on macOS, Linux and Windows. For now it is installed as an unpacked extension; a Chrome Web Store listing is planned.',
      },
      {
        q: 'Which AI models can it use?',
        a: 'Local models through Ollama or LM Studio, or cloud models from OpenRouter, NVIDIA, OpenAI, Anthropic, Google Gemini, xAI, DeepSeek and Azure with your own key. You can choose a different model for each chat.',
      },
      {
        q: 'Can it send, post or buy something without me?',
        a: 'Not as it ships. Every send, post, form submission, deletion, purchase and permission change stops at a card until you hold the button or click twice. Each kind can be switched off in Settings, and helper agents refuse to run unless all of them are on. Routines and agents put those steps in your Inbox instead.',
      },
      {
        q: 'What does it send, and to whom?',
        a: 'Your task and the parts of the page it needs go to the model provider you chose. Nothing goes to us: there is no server, no account and no analytics.',
      },
      {
        q: 'Does it read my passwords or cookies?',
        a: 'No. It does not read or send cookies or saved logins, and it never types into a password field. Sign-ins, CAPTCHAs and one-time codes are handed back to you.',
      },
      {
        q: `What is ${COMPANION}?`,
        a: `An optional companion for macOS. It runs code for your routines in a Docker sandbox on your Mac and shows what it builds in Avi Studio. ${PRODUCT} works fully without it.`,
      },
      {
        q: 'How is it related to Nanobrowser?',
        a: `${PRODUCT} is a fork of Nanobrowser, the open-source browser agent (Apache-2.0). It adds the confirmation gate, threads, meeting notes, memory, voice, routines and agents, and removes analytics.`,
      },
    ],
  },
  closing: {
    title: 'Hand it the work. Keep the last click.',
    body: 'One command downloads it. One click in your browser turns it on.',
  },
};

// ─── The gate demo (home hero) ─────────────────────────────────────────────────────────────────────────────────────

interface DemoStep {
  icon: string;
  label: string;
  detail?: string;
}

const DRAFT = 'Hi Maya — Thursday at 3 works. Yesterday we agreed: beta on the 20th, pricing stays free.';

export const demo = {
  label: `Live demo: ${PRODUCT} replies to an email, then waits for your click before sending`,
  host: 'mail.example.com',
  path: '/inbox/thursday-review',
  panelLabel: `${PRODUCT} side panel`,
  crumbs: ['Chats', 'Reply to Maya'],
  email: {
    initials: 'MO',
    from: 'Maya Okafor',
    meta: 'to me · 9:41',
    subject: 'Thursday review — can we move it?',
    body: ['Hi! Could we move Thursday’s review to 3 pm?', 'And what did we decide yesterday? I dropped off early.'],
    actions: ['Reply', 'Forward'],
    to: 'To: Maya Okafor',
    send: 'Send',
    sentLabel: 'Sent just now',
    you: 'You',
  },
  prompt: 'Reply to Maya. Thursday at 3 is fine.',
  draft: DRAFT,
  // A step may carry a detail line in mono under its label, as the panel shows a target
  steps: [
    { icon: 'read', label: 'Read Maya’s email' },
    { icon: 'search', label: 'Found 2 decisions in Monday’s call' },
    { icon: 'click', label: 'Clicked Reply' },
    { icon: 'type', label: 'Typed the reply' },
  ] as DemoStep[],
  planning: t('chat_run_planning'),
  working: t('chat_run_working'),
  // {count} is filled in by the demo
  runSteps: t('chat_run_steps', ['{count}']),
  held: t('chat_run_held', [t('gate_kind_send')]),
  card: {
    title: t('gate_card_title', [t('gate_kind_send')]),
    pageLabel: t('gate_card_page'),
    page: 'Thursday review — can we move it?',
    fields: [{ label: 'Message', value: DRAFT }],
    stop: 'Stop',
    hold: 'Hold to send',
    armed: 'Click again to send',
    hint: 'Hold to send, or click twice. Stop sends nothing.',
  },
  sent: {
    steps: [t('gate_approved', [t('gate_kind_send')]), t('gate_verify_shown')],
    answer: 'Sent. Maya has your reply, with both decisions.',
    announce: 'Sent. Checked: the reply shows on the page.',
  },
  stopped: {
    steps: [t('gate_declinedByUser', [t('gate_kind_send')])],
    // Stopped before it reached the gate
    early: [t('exec_task_cancel')],
    answer: 'Stopped. Nothing was sent, and your draft is still in the reply box.',
    earlyAnswer: 'Stopped. Nothing was sent.',
    announce: 'Stopped. Nothing was sent.',
  },
  waitingAnnounce: `Waiting for your click: ${t('gate_kind_send')} to Maya Okafor.`,
  replay: 'Run it again',
  // The composer's own labels, as the panel reads them
  composer: {
    form: t('chat_input_form'),
    editor: t('chat_input_editor'),
    placeholder: t('chat_input_placeholder'),
    attach: t('chat_input_attach'),
    stop: t('chat_buttons_stop'),
    send: t('chat_buttons_send'),
  },
  footer: t('chat_footer_gate'),
  caption: 'Hold the amber button, or hold Enter on it. Stop sends nothing.',
  noscript: 'Turn on JavaScript to try the hold yourself.',
};

// ─── Install ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const install = {
  title: `Install ${PRODUCT} — one command for Brave, Chrome and Edge`,
  description: `Install ${PRODUCT} on macOS or Linux with one command, or by hand on Windows, then turn it on in Brave, Chrome or Edge. How to update, remove it, add local voices and the optional Mac companion.`,
  ogAlt: `Install ${PRODUCT}: one command in the terminal, then Load unpacked in your browser.`,
  breadcrumb: 'Install',
  heading: `Install ${PRODUCT}`,
  lede: 'One command downloads it. Then you turn it on in your browser, once. About two minutes, and no account.',
  tabsLabel: 'Your system',
  tabs: [
    {
      id: 'macos',
      label: 'macOS',
      command: INSTALL_COMMAND,
      note: 'Paste it into Terminal and press Return.',
    },
    {
      id: 'linux',
      label: 'Linux',
      command: INSTALL_COMMAND,
      note: 'Paste it into a terminal. It needs curl.',
    },
    {
      id: 'windows',
      label: 'Windows',
      command: null,
      badge: 'Script coming',
      note: 'A PowerShell installer is on its way. Until then, install by hand: download the latest build, unzip it, and load the folder as below.',
    },
  ],
  script: {
    title: 'What the command does',
    body: 'It downloads the latest build from this site and unpacks it into a folder on your computer. Browsers don’t let a script switch an extension on by itself, so the last step is yours.',
    read: { href: links.installScript, label: 'Read the script first' },
    manual: { href: links.releases, label: 'Latest build, for a manual install' },
  },
  load: {
    id: 'load',
    title: 'Turn it on in your browser',
    body: 'Do this once. Afterwards the extension starts with your browser.',
    browsers: [
      {
        name: 'Brave',
        page: 'brave://extensions',
        steps: [
          'Open brave://extensions in the address bar.',
          'Switch on Developer mode, at the top right.',
          'Click Load unpacked and choose the Avi Copilot folder.',
          'Pin it from the puzzle-piece menu, then click its icon to open the panel.',
        ],
      },
      {
        name: 'Chrome',
        page: 'chrome://extensions',
        steps: [
          'Open chrome://extensions in the address bar.',
          'Switch on Developer mode, at the top right.',
          'Click Load unpacked and choose the Avi Copilot folder.',
          'Pin it from the puzzle-piece menu, then click its icon to open the panel.',
        ],
      },
      {
        name: 'Edge',
        page: 'edge://extensions',
        steps: [
          'Open edge://extensions in the address bar.',
          'Switch on Developer mode, in the left column.',
          'Click Load unpacked and choose the Avi Copilot folder.',
          'Show it in the toolbar from the extensions menu, then click its icon to open the panel.',
        ],
      },
    ],
    first: `In the panel, add a model: a key for a cloud provider, or Ollama or LM Studio running on your computer. Then ask it for something small, like “summarise this page”.`,
  },
  update: {
    id: 'update',
    title: 'Update',
    body: [
      'Run the same command again. Then press the reload arrow on the extension’s card in your browser’s extensions page.',
      'Your chats, notes and settings stay. They live in the browser, not in the folder, and the extension keeps its ID across builds.',
    ],
  },
  remove: {
    id: 'remove',
    title: 'Remove',
    body: [
      'Click Remove on the extension’s card. That also deletes everything it stored: chats, memory, settings and keys.',
      'Then delete its folder, or let the script do it:',
    ],
    command: installCommandWith('--uninstall'),
  },
  voices: {
    id: 'voices',
    title: 'Local voices',
    badge: 'Optional',
    body: [
      'Voices and speech recognition that run on your computer, for free: KittenTTS to speak and Moonshine to listen, about 60 MB together. Kokoro and Whisper are there if you want more.',
      'Add them with the same command and one option. It needs Node.js; then reload the extension and choose them in the panel, under Settings › Voice engines.',
    ],
    command: installCommandWith('--with-voices'),
  },
  brain: {
    id: 'brain',
    title: COMPANION,
    badge: 'Optional · macOS · coming soon',
    body: `A small companion that runs on your Mac and does what a browser extension can’t. ${PRODUCT} works fully without it.`,
    addsLabel: 'What it adds',
    adds: [
      'Runs code for your routines in a Docker sandbox: no network unless you allow it, limits on CPU, memory and time, and only its own folder.',
      'Builds small pages and tools, and shows them in Avi Studio.',
      'Listens only on this Mac, at 127.0.0.1, and pairs with your browser through a one-time code.',
    ],
    needsLabel: 'What it needs',
    needs: ['macOS', 'Docker Desktop, OrbStack or Colima', 'Node 24 or newer'],
    setup: `Its installer is not public yet; it will be one command, like this page’s. Then you open Settings › ${COMPANION} in the panel, enter the port and the code, and pair.`,
  },
};

// ─── Privacy ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const privacy = {
  title: `Privacy — ${PRODUCT}`,
  description: `What ${PRODUCT} keeps in your browser, what leaves your machine and where it goes, what never does, and why it asks for each browser permission.`,
  ogAlt: `${PRODUCT} privacy: what stays on your machine and what leaves it.`,
  breadcrumb: 'Privacy',
  heading: 'What stays on your machine',
  updated: '12 October 2026',
  updatedLabel: 'Last updated',
  lede: `${PRODUCT} has no server, no account and no analytics. It keeps your data in your browser, and sends only what a task needs to the services you chose.`,
  label: {
    title: 'What leaves your machine',
    caption: 'Per task, and only for the features you use.',
    groups: [
      {
        tone: 'stays',
        heading: 'Stays in your browser',
        rows: [
          { what: 'Chats, meeting notes, memory, routines and settings', where: 'Browser storage' },
          { what: 'API keys and connector sign-ins', where: 'Encrypted vault' },
        ],
      },
      {
        tone: 'leaves',
        heading: 'Leaves, to the service you chose',
        rows: [
          { what: 'Your task and the page it works on', where: 'Your model provider' },
          { what: 'Meeting audio and dictation', where: 'Your speech-to-text model' },
        ],
      },
      {
        tone: 'never',
        heading: 'Never leaves',
        rows: [
          { what: 'Cookies and saved passwords', where: 'Never read' },
          { what: 'Analytics or usage tracking', where: 'None' },
          { what: 'Anything to us', where: 'No server' },
        ],
      },
    ],
    footnote: 'With a model on your computer, such as Ollama or LM Studio, page text stays on your computer too.',
  },
  sections: [
    {
      id: 'stored',
      title: 'What it keeps, and where',
      items: [
        {
          title: 'Your work',
          body: 'Chats, meeting notes and transcripts, memory, routines, agents and the Inbox are kept in your browser profile (IndexedDB). Settings are kept in the extension’s own storage.',
        },
        {
          title: 'Your keys',
          body: 'API keys and connector sign-ins are encrypted in a vault in your browser (AES-GCM, with a key the browser will not export). Pages and settings only ever see the last four characters.',
        },
        {
          title: 'Removing it',
          body: 'Removing the extension deletes all of it. Memory can also be exported, imported or wiped from Settings.',
        },
      ],
    },
    {
      id: 'leaves',
      title: 'What leaves, and where it goes',
      items: [
        {
          title: 'To your model provider',
          body: 'Your task, the text of the page it is working on (and a screenshot, only when vision is on), and the earlier messages and notes the task needs.',
        },
        {
          title: 'To your speech provider',
          body: 'Meeting audio when you take notes, what you dictate into the chat box, and your voice in a Gemini Live conversation. In economy mode, speech is written down on your computer and only text goes to your model. The “Hey Ava” wake word never leaves your computer.',
        },
        {
          title: 'For search by meaning',
          body: 'Passages added to memory are turned into vectors by Gemini if you use it, by Ollama on your computer, or not at all: keyword search works without either.',
        },
        {
          title: 'To the tools you connect',
          body: 'Connectors (MCP servers) receive only the tool calls you allow. A tool that writes asks first.',
        },
        {
          title: 'Checking a key',
          body: 'Saving a Gemini key sends it to Google once, to check that it works.',
        },
      ],
    },
    {
      id: 'never',
      title: 'What never leaves',
      items: [
        {
          title: 'Cookies and saved logins',
          body: 'The agent does not read or send them, and it never types into a password field.',
        },
        {
          title: 'Analytics',
          body: 'There is none: no usage tracking, no crash reporting, no telemetry. Upstream’s analytics were removed.',
        },
        {
          title: 'Us',
          body: `There is no ${PRODUCT} server. Nothing is sent to the people who make it.`,
        },
      ],
    },
  ],
  permissions: {
    id: 'permissions',
    title: 'Why it asks for each permission',
    lede: 'Browser extensions list what they may do. Here is what each one is for.',
    headers: { name: 'Permission', why: 'What it is for' },
    items: [
      {
        name: 'Read and change data on all websites',
        why: 'To read and act on the pages you give it a task on. A blocked-sites list keeps it off sites you name.',
      },
      { name: 'Side panel', why: 'To sit next to the page you are working on.' },
      { name: 'Tabs and tab groups', why: 'To see and group the tabs a chat works in, and keep each chat to its own.' },
      { name: 'Scripting and active tab', why: 'To read pages and press buttons in them.' },
      {
        name: 'Debugger',
        why: 'To click and type the way a person does. The browser shows a bar while it is attached.',
      },
      { name: 'Web navigation', why: 'To know when a page has finished loading.' },
      { name: 'Storage, unlimited', why: 'To keep chats, notes and memory in your browser without a size cap.' },
      {
        name: 'Tab capture and offscreen',
        why: 'To record a call’s audio when you start meeting notes, and to listen for “Hey Ava” with the panel closed.',
      },
      { name: 'Top sites', why: 'So voice can find “my email” among the sites you visit most.' },
      { name: 'Alarms and notifications', why: 'To remind you of meetings and tell you when something needs you.' },
      { name: 'Text to speech', why: 'To read answers aloud with your computer’s own voices.' },
      { name: 'Identity', why: 'To sign in to connectors through the browser’s own sign-in window.' },
    ],
  },
  site: {
    id: 'this-site',
    title: 'This website',
    body: 'This site is static pages. It sets no cookies, runs no analytics and loads no scripts, fonts or images from anyone else. Your theme choice is kept in your browser’s local storage.',
  },
};

// ─── 404 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const notFound = {
  title: `Page not found — ${PRODUCT}`,
  description: 'This page does not exist.',
  kicker: '404',
  heading: 'Nothing here.',
  body: 'The page may have moved, or the link was mistyped. These go somewhere:',
  links: [
    { href: links.home, label: 'Home', note: 'What it is, and the gate' },
    { href: links.install, label: 'Install', note: 'One command, then one click' },
    { href: links.privacy, label: 'Privacy', note: 'What stays on your machine' },
  ],
};

// ─── OG cards (rendered to /og/*.png at build) ─────────────────────────────────────────────────────────────────────

export const og = {
  home: { kicker: 'For Brave, Chrome and Edge', title: 'The AI browser copilot that waits for your click.' },
  install: { kicker: 'Install', title: 'One command, then one click in your browser.' },
  privacy: { kicker: 'Privacy', title: 'What stays on your machine.' },
};

// ─── llms.txt ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const llms = {
  summary: product.description,
  facts: [
    'Runs in the side panel of Brave, Chrome and Edge (Manifest V3) on macOS, Linux and Windows.',
    'Free, no account, no analytics, no server of its own.',
    'Works on any site: reads pages, clicks, types, fills forms, works across tabs; several chats can run at once.',
    'A confirmation gate: sending, posting, submitting, deleting, publishing, buying and changing permissions wait for a press-and-hold or two clicks.',
    'Meeting notes from browser calls (Meet, Zoom, Teams): live transcript, rolling summary, decisions and action items.',
    'Memory across chats, meetings and saved pages, with cited answers and a knowledge graph.',
    'Voice: an on-device “Hey Ava” wake word, Gemini Live or local speech engines, dictation.',
    'Routines drawn as diagrams, helper agents with budgets, an Inbox for approvals, MCP connectors.',
    'Models: Ollama, LM Studio, OpenRouter, NVIDIA NIM, OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Azure OpenAI.',
    'A fork of Nanobrowser (Apache-2.0).',
  ],
};
