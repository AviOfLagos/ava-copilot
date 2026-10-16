// Ava as the master interface: the capability list (built from every registration), tab awareness, the audio and
// model checks, opening any place in the panel, and voice tools for panel features that had none.
import { z } from 'zod';
import {
  AgentNameEnum,
  agentModelStore,
  audioDeviceSettingsStore,
  speechToTextModelStore,
  ttsSettingsStore,
  voiceTtsEngine,
} from '@extension/storage';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';
import { closeOffscreenIfIdle, ensureOffscreen, toOffscreen } from '../offscreen';
import { registerAgentAction, registerCommand, registerVoiceTool } from '../registry';
import { services } from '../registry/services';
import { spokenYes } from '../identity/settings';
import { describeAudioCheck } from './audio-check';
import type { MicMeasurement, ToneResult } from './audio-check';
import { compactCapabilities, findPlace, fullCapabilities, capabilityNames } from './catalog';
import { currentTabLine, currentTarget, tabAllowed, tabTracker } from './instance';
import { describeModelCheck, isRecommended, recommend } from './model-check';
import type { Recommendation } from './model-check';
import { loadPanelCatalog, openInPanel, panelCatalogSchema, savePanelCatalog } from './panel';
import { modelOptions, probeModels } from './probes';
import { currentCapabilities } from './sources';
import { focusLine } from './tabs';
import {
  listConnectors,
  listPersonalities,
  listWorkspaces,
  manageInbox,
  readConfirmCards,
  startMeetingNotes,
  stopMeetingNotes,
  waitingThreadFor,
} from './tools';

const logger = createLogger('Capabilities');

// ── Tab awareness ─────────────────────────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(info => void tabTracker.activated(info.tabId, info.windowId));
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (tab.active && (change.title !== undefined || change.url !== undefined)) tabTracker.updated(tab);
});
chrome.tabs.onRemoved.addListener(tabId => tabTracker.removed(tabId));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void tabTracker.refresh();
});
void tabTracker.start().catch(error => logger.warning('Tab tracking did not start', error));

// The conversation hears about a switch at once, as quiet context: no turn, no confirmation
let lastContext = '';
tabTracker.onChange(focus => {
  void (async () => {
    let voice;
    try {
      voice = services().voice;
    } catch {
      return;
    }
    if (!voice.running) {
      lastContext = '';
      return;
    }
    const line = focusLine(focus, tabAllowed);
    if (!line || line === lastContext) return;
    lastContext = line;
    await toOffscreen({ type: 'voice_context', text: `System context (no reply needed): ${line}` }).catch(() => {});
  })();
});

// ── The panel's places and settings sections ──────────────────────────────────────────────────────

void loadPanelCatalog();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'capabilities_panel') return;
  // Only the extension's own pages (the panel, also when opened as a tab), never a content script
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const parsed = panelCatalogSchema.safeParse(message.catalog);
  if (!parsed.success) {
    sendResponse({ ok: false });
    return;
  }
  void savePanelCatalog(parsed.data).then(() => sendResponse({ ok: true }));
  return true;
});

/** The capability list and the tab line, for the panel and the tests. */
registerCommand(
  'capabilities_list',
  z.object({ type: z.literal('capabilities_list'), requestId: z.string().optional() }),
  (_input, context) => {
    const capabilities = currentCapabilities();
    context.reply({
      type: 'capabilities_list',
      requestId: context.requestId,
      names: capabilityNames(capabilities),
      text: fullCapabilities(capabilities),
      compact: compactCapabilities(capabilities),
      tab: currentTabLine(),
    });
  },
);

// ── Opening places ────────────────────────────────────────────────────────────────────────────────

async function openPlace(spoken: string): Promise<string> {
  const said = spoken.trim();
  if (!said) return 'Say which place to open.';
  const waiting = await waitingThreadFor(said);
  if (waiting) {
    const outcome = await openInPanel({ place: 'chat', threadId: waiting.id });
    return outcome === 'shown'
      ? `Opened the chat "${waiting.title}" in the side panel; its card is there.`
      : 'The side panel is closed. It opens there when the user opens the panel (the toolbar button).';
  }
  const capabilities = currentCapabilities();
  const found = findPlace(capabilities, said);
  if (!found) {
    return `There is no place called "${said}". The places are: ${[
      ...capabilities.places,
      ...capabilities.settingsSections,
    ]
      .map(entry => entry.label)
      .join(', ')}.`;
  }
  const outcome =
    found.kind === 'place'
      ? await openInPanel({ place: found.entry.id, label: found.entry.label })
      : await openInPanel({ place: 'settings', section: found.entry });
  const name = found.kind === 'place' ? found.entry.label : `Settings › ${found.entry.label}`;
  return outcome === 'shown'
    ? `Opened ${name} in the side panel.`
    : `The side panel is closed: ${name} opens as soon as the user opens it (the toolbar button).`;
}

// ── Checks ────────────────────────────────────────────────────────────────────────────────────────

async function checkAudio(): Promise<string> {
  const [devices, tts] = await Promise.all([audioDeviceSettingsStore.getSettings(), ttsSettingsStore.getSettings()]);
  await ensureOffscreen();
  try {
    const mic = await toOffscreen<MicMeasurement>({
      type: 'audio_check_mic',
      micDeviceId: devices.mic?.deviceId ?? null,
      durationMs: 2000,
    }).catch(error => ({ ok: false, levels: [], error: String(error) }) as MicMeasurement);
    const tone = await toOffscreen<ToneResult>({
      type: 'audio_check_tone',
      speakerDeviceId: devices.speaker?.deviceId ?? null,
    }).catch(error => ({ ok: false, error: String(error) }) as ToneResult);
    return describeAudioCheck({
      micChoice: devices.mic?.label || 'System default',
      speakerChoice: devices.speaker?.label || 'System default',
      mic,
      tone: { ...tone, label: devices.speaker?.label || 'the system default speaker' },
      systemVoice: voiceTtsEngine(tts.engine) === 'system',
    });
  } finally {
    void closeOffscreenIfIdle();
  }
}

// What check_model recommended last: switch_model may only switch to one of these
let recommendations: Recommendation[] = [];
let failedProviders = new Map<string, string | null>();

async function checkModel(): Promise<string> {
  let voiceRunning = false;
  try {
    voiceRunning = services().voice.running;
  } catch {
    // Not started yet
  }
  const [probes, { options, extra }] = await Promise.all([probeModels(voiceRunning), modelOptions()]);
  recommendations = recommend(probes, options);
  failedProviders = new Map(probes.map(probe => [probe.use, probe.providerId]));
  return describeModelCheck(probes, recommendations, extra);
}

async function switchModel(args: Record<string, unknown>, heard: string): Promise<string> {
  const use = String(args.use ?? '');
  const providerId = String(args.provider ?? '');
  const model = String(args.model ?? '');
  const recommended = isRecommended(recommendations, use, providerId, model);
  if (!recommended) return 'Only a switch check_model just recommended can be made. Call check_model first.';
  if (args.confirmed !== true) {
    return `Not switched yet. Ask the user: "Switch ${use} to ${recommended.switchTo!.label}?" Call again with confirmed true only after they say yes.`;
  }
  if (!spokenYes(heard)) return 'The user has not said yes to the switch. Ask them first.';
  if (use === 'chat') {
    const before = failedProviders.get('chat');
    await agentModelStore.setAgentModel(AgentNameEnum.Navigator, { provider: providerId, modelName: model });
    const planner = await agentModelStore.getAgentModel(AgentNameEnum.Planner);
    // The planner moves too when it ran on the same failing provider
    if (!planner || planner.provider === before) {
      await agentModelStore.setAgentModel(AgentNameEnum.Planner, { provider: providerId, modelName: model });
    }
  } else if (use === 'speech') {
    await speechToTextModelStore.setSpeechToTextModel({ provider: providerId, modelName: model });
  } else {
    return 'That can only be switched in Settings.';
  }
  recommendations = recommendations.filter(item => item !== recommended);
  return `Switched ${use} to ${recommended.switchTo!.label}. It applies from the next request.`;
}

// ── Voice tools ───────────────────────────────────────────────────────────────────────────────────

registerVoiceTool({
  declaration: {
    name: 'what_can_you_do',
    description:
      'Lists everything you can do, grouped: your tools, what the chat agent can do, and the places and settings you can open. Use it when the user asks what you can do or which tools you have, and before ever saying you cannot do something.',
  },
  // Free (voice/guard.ts): it reads only the assistant's own abilities
  guardLabel: 'list what it can do',
  handler: async () => fullCapabilities(currentCapabilities()),
});

registerVoiceTool({
  declaration: {
    name: 'open_place',
    description:
      'Opens a place in the side panel (Inbox, Workflows, Agents, Connectors, Models & usage, Meetings, Knowledge…), a Settings section (Audio devices, Voice engines, Personalities…), or the chat of a waiting confirm card, by its name.',
    parameters: {
      type: 'OBJECT',
      properties: { place: { type: 'STRING', description: 'what the user called it, e.g. "audio devices"' } },
      required: ['place'],
    },
  },
  guardLabel: 'open a place in the side panel',
  handler: async args => openPlace(String(args.place ?? '')),
});

registerVoiceTool({
  declaration: {
    name: 'check_audio',
    description:
      'Checks the microphone and speaker: says which are chosen, measures the mic for two seconds (ask the user to say something while it listens), and plays a short test tone on the speaker. Then ask whether they heard the tone.',
  },
  guardLabel: 'check your microphone and speaker',
  handler: async () => checkAudio(),
});

registerVoiceTool({
  declaration: {
    name: 'check_model',
    description:
      'Checks the models in use (chat, voice, speech-to-text) with tiny requests: whether each answers, how fast, rate limits and errors, and recommends a concrete switch when one is not working well.',
  },
  guardLabel: 'check your models',
  handler: async () => checkModel(),
});

registerVoiceTool({
  declaration: {
    name: 'switch_model',
    description:
      'Switches a model to the one check_model recommended. First call it without confirmed: it tells you what to ask. Call again with confirmed true only after the user says yes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        use: { type: 'STRING', description: 'chat or speech' },
        provider: { type: 'STRING', description: 'the provider id check_model gave' },
        model: { type: 'STRING', description: 'the model check_model gave' },
        confirmed: { type: 'BOOLEAN', description: 'true only after the user said yes' },
      },
      required: ['use', 'provider', 'model'],
    },
  },
  guardLabel: 'switch a model',
  handler: (args, heard) => switchModel(args, heard),
});

registerVoiceTool({
  declaration: {
    name: 'start_meeting_notes',
    description: 'Starts taking meeting notes on the tab in front (a call in Meet, Zoom or Teams).',
  },
  guardLabel: 'start meeting notes',
  handler: async () => {
    const tab = currentTarget();
    return startMeetingNotes(tab?.tabId, tab?.windowId);
  },
});

registerVoiceTool({
  declaration: {
    name: 'stop_meeting_notes',
    description: 'Stops the meeting notes being taken; the summary follows in Meetings.',
  },
  guardLabel: 'stop meeting notes',
  handler: async () => stopMeetingNotes(),
});

registerVoiceTool({
  declaration: {
    name: 'read_confirm_cards',
    description:
      'Reads out what waits for the user’s click: confirm cards in chats (what would be sent or submitted, and where) and approvals in the Inbox. Answering is always their click.',
  },
  guardLabel: 'read what waits for your click',
  handler: async () => readConfirmCards(),
});

registerVoiceTool({
  declaration: {
    name: 'manage_inbox',
    description:
      'Marks an Inbox item done or read, or snoozes it, found by words of its title. Approvals are answered by the user’s click in the Inbox.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'done, read or snooze' },
        item: { type: 'STRING', description: 'words of the item’s title' },
        hours: { type: 'INTEGER', description: 'for snooze: how many hours; 3 if left out' },
      },
      required: ['action', 'item'],
    },
  },
  guardLabel: 'change an Inbox item',
  handler: async args => manageInbox(args),
});

registerVoiceTool({
  declaration: {
    name: 'list_connectors',
    description: 'Lists the connectors (Slack, GitHub, Notion…) and whether each is connected or needs a sign-in.',
  },
  guardLabel: 'list your connectors',
  handler: async () => listConnectors(),
});

registerVoiceTool({
  declaration: { name: 'list_workspaces', description: "Lists the user's workspaces and which one is the default." },
  guardLabel: 'list your workspaces',
  handler: async () => listWorkspaces(),
});

registerVoiceTool({
  declaration: {
    name: 'list_personalities',
    description: 'Lists the personalities you can switch to with set_personality, and which one is in use.',
  },
  guardLabel: 'list the personalities',
  handler: async () => listPersonalities(),
});

// ── Chat actions ──────────────────────────────────────────────────────────────────────────────────

const intent = z.string().default('').describe('purpose of this action');

const whatCanYouDoSchema = {
  name: 'what_can_you_do',
  description: 'List everything the assistant can do (tools, places, settings), to answer "what can you do?"',
  schema: z.object({ intent }),
} satisfies ActionSchema;

const openPlaceSchema = {
  name: 'open_place',
  description: 'Open a place in the side panel or a Settings section by its name, e.g. "Audio devices", "Inbox"',
  schema: z.object({ intent, place: z.string().describe('the place or section the user named') }),
} satisfies ActionSchema;

const checkAudioSchema = {
  name: 'check_audio',
  description: "Check the user's microphone level and play a test tone on their speaker",
  schema: z.object({ intent }),
} satisfies ActionSchema;

const checkModelSchema = {
  name: 'check_model',
  description: 'Check the models in use (chat, voice, speech-to-text) with tiny requests and recommend a switch',
  schema: z.object({ intent }),
} satisfies ActionSchema;

function actionResult(context: AgentContext, text: string): ActionResult {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, text.split('\n')[0].slice(0, 200));
  return new ActionResult({ extractedContent: text, includeInMemory: true });
}

registerAgentAction({
  // Read each time a prompt is built: the list and the user's tab are current, never fixed at startup
  get prompt() {
    const tab = currentTabLine();
    return `- what_can_you_do / open_place / check_audio / check_model: you are the user's hub. Never say you cannot do something listed here; when asked what you can do, call what_can_you_do. open_place opens any place or Settings section in the panel. check_model only recommends; a switch is the user's choice (by voice, or in Models & usage).
What you and the voice assistant can do (summary):
${compactCapabilities(currentCapabilities())}${tab ? `\n${tab}` : ''}`;
  },
  create: (context: AgentContext) =>
    new Action(async () => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Listing what I can do');
      return actionResult(context, fullCapabilities(currentCapabilities()));
    }, whatCanYouDoSchema),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(async (input: z.infer<typeof openPlaceSchema.schema>) => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Opening a place');
      return actionResult(context, await openPlace(input.place));
    }, openPlaceSchema),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(async () => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Checking the microphone and speaker');
      return actionResult(context, await checkAudio());
    }, checkAudioSchema),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(async () => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Checking the models');
      return actionResult(context, await checkModel());
    }, checkModelSchema),
});
