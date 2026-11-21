import { z } from 'zod';
import {
  ambientSettingsStore,
  ambientStore,
  assistantNameOf,
  generalSettingsStore,
  localSttChoice,
  voiceEngineSettingsStore,
} from '@extension/storage';
import type { AmbientSettingsConfig, SttChoice } from '@extension/storage';
import { createLogger } from '../log';
import { closeOffscreenIfIdle, ensureOffscreen, toOffscreen } from '../offscreen';
import { registerCommand, registerOffscreenBusy, registerVoiceTool } from '../registry';
import { services } from '../registry/services';
import { installedVoiceModels } from '../voice/engines/models';
import { showIndicator } from './indicator';
import { correctedText } from '../voice/vocabulary';
import { AmbientManager } from './manager';
import { plainSpeech } from './phrases';

/**
 * Ambient listening (docs/ambient-plan.md, A1): keeps the offscreen listener running while Settings › Ambient is on,
 * takes its utterances, and answers the panel. See ./manager for what happens to what Ava hears.
 */

const logger = createLogger('Ambient');

const CHECK_ALARM = 'ambient-check';
const RETENTION_ALARM = 'ambient-retention';
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

type StartReply = { ok?: boolean; error?: string; micDenied?: boolean };

/** Asks the offscreen document to listen; a document opened a moment ago may not be taking messages yet. */
async function startOffscreen(config: Record<string, unknown>): Promise<StartReply> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return await toOffscreen<StartReply>({ type: 'ambient_start', config });
    } catch (error) {
      if (attempt >= 10 || !String(error).includes('Receiving end does not exist')) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function stopOffscreen(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (!open.length) return;
  await toOffscreen({ type: 'ambient_stop' }).catch(() => {});
  await closeOffscreenIfIdle();
}

/** The recogniser settings call for, and the smallest one installed for a low battery. */
async function sttChoices(): Promise<{ stt: SttChoice; lowPowerStt: SttChoice } | null> {
  const [settings, installed] = await Promise.all([voiceEngineSettingsStore.getSettings(), installedVoiceModels()]);
  const stt = localSttChoice(settings, installed);
  if (!stt) return null;
  const tiny = installed['moonshine-tiny'];
  const lowPowerStt: SttChoice = tiny
    ? { engine: 'moonshine', model: 'moonshine-tiny', webgpu: settings.sttGpu && Boolean(tiny.webgpu) }
    : stt;
  return { stt, lowPowerStt };
}

async function nameWords(): Promise<string[]> {
  const { assistantName } = await generalSettingsStore.getSettings();
  return plainSpeech(assistantNameOf(assistantName)).split(' ').filter(Boolean);
}

export const ambient = new AmbientManager({
  settings: ambientSettingsStore,
  store: ambientStore,
  kb: () => services().kb,
  offscreen: { start: startOffscreen, stop: stopOffscreen },
  stt: sttChoices,
  nameWords,
  indicate: state => void showIndicator(state),
  correct: text => correctedText(text),
});

// Every change in Settings › Ambient (the panel, a spoken switch, the voice tool) is applied from here
let previous: AmbientSettingsConfig | null = null;
ambientSettingsStore.subscribe(() => {
  void (async () => {
    const next = await ambientSettingsStore.getSettings();
    const before = previous;
    previous = next;
    if (before && before.cloudAllowed !== next.cloudAllowed) await ambient.cloudChanged(next.cloudAllowed);
    if (!before || before.mode !== next.mode || before.offRecord !== next.offRecord) await ambient.sync();
  })().catch(error => logger.error('Applying the ambient settings failed', error));
});

// The offscreen document's ambient messages; only it may send them
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(OFFSCREEN_URL)) return;
  if (message?.type === 'ambient_utterance') {
    void ambient
      .heard({
        text: String(message.text ?? ''),
        startedAt: Number(message.startedAt) || Date.now(),
        endedAt: Number(message.endedAt) || Date.now(),
      })
      .catch(error => logger.error('Keeping an utterance failed', error));
  } else if (message?.type === 'ambient_back_on_record') {
    void ambient.backOnRecord();
  } else if (message?.type === 'ambient_error') {
    logger.warning('Ambient listening lost an utterance', String(message.error ?? ''));
  }
  return;
});

registerOffscreenBusy('ambient', async () => (await ambientSettingsStore.getSettings()).mode !== 'off');

void chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 1 });
void chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 6 * 60 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CHECK_ALARM) {
    // Keeps listening through a closed or crashed offscreen document
    void (async () => {
      const { mode } = await ambientSettingsStore.getSettings();
      if (mode === 'off') return;
      const status = await toOffscreen<{ running?: boolean }>({ type: 'ambient_running' }).catch(() => ({
        running: false,
      }));
      if (!status?.running) await ambient.sync();
    })().catch(error => logger.error('Ambient check failed', error));
  }
  if (alarm.name === RETENTION_ALARM) {
    void ambient.applyRetention().catch(error => logger.error('Ambient retention failed', error));
  }
});
chrome.runtime.onStartup.addListener(() => void ambient.sync());
void ambient.sync().catch(error => logger.error('Ambient start failed', error));

const reply =
  (context: { reply: (message: Record<string, unknown>) => void; requestId: string | null }) =>
  async (type: string, extra: Record<string, unknown> = {}) =>
    context.reply({ type, requestId: context.requestId, ...(await ambient.state()), ...extra });

registerCommand(
  'ambient_state',
  z.object({ type: z.literal('ambient_state'), requestId: z.string().optional() }),
  async (_input, context) => reply(context)('ambient_state'),
);

// Settings › Ambient and the panel's indicator: the mode, off the record, the cloud permission
registerCommand(
  'ambient_set',
  z.object({
    type: z.literal('ambient_set'),
    requestId: z.string().optional(),
    mode: z.enum(['off', 'listen', 'companion']).optional(),
    offRecord: z.boolean().optional(),
    cloudAllowed: z.boolean().optional(),
  }),
  async (input, context) => {
    const changes: Partial<AmbientSettingsConfig> = {};
    if (input.mode) changes.mode = input.mode;
    if (input.mode === 'off') Object.assign(changes, { offRecord: false, offRecordSince: null });
    if (input.offRecord !== undefined) {
      changes.offRecord = input.offRecord;
      changes.offRecordSince = input.offRecord ? Date.now() : null;
    }
    if (input.cloudAllowed !== undefined) changes.cloudAllowed = input.cloudAllowed;
    await ambientSettingsStore.updateSettings(changes);
    const result = await ambient.sync();
    await reply(context)('ambient_state', { error: result.ok ? undefined : result.error, micDenied: result.micDenied });
  },
);

registerCommand(
  'ambient_forget',
  z.object({
    type: z.literal('ambient_forget'),
    requestId: z.string().optional(),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
  }),
  async (input, context) => {
    const result = await ambient.forget(input.minutes);
    context.reply({ type: 'ambient_forget', requestId: context.requestId, ...result });
  },
);

registerVoiceTool({
  declaration: {
    name: 'set_listening_mode',
    description:
      'Turns ambient listening on or off. "listen": you quietly write down what is said around the user, on this Mac, and never answer unless spoken to with the wake word. "companion": the same for now. "off": you stop writing anything down. Use it when the user says "just listen", "feel free to chime in", or "stop listening".',
    parameters: {
      type: 'OBJECT',
      properties: { mode: { type: 'STRING', description: 'listen, companion or off' } },
      required: ['mode'],
    },
  },
  guardLabel: 'change ambient listening',
  handler: async args => {
    const mode = String(args.mode ?? '').toLowerCase();
    if (mode !== 'listen' && mode !== 'companion' && mode !== 'off') return 'Say listen, companion or off.';
    await ambientSettingsStore.updateSettings(
      mode === 'off' ? { mode, offRecord: false, offRecordSince: null } : { mode },
    );
    const result = await ambient.sync();
    if (!result.ok && mode !== 'off') {
      return result.error === 'missing_stt'
        ? 'Listening needs a speech recogniser on this Mac first: Settings › Voice engines.'
        : `Listening did not start: ${result.error ?? 'unknown error'}`;
    }
    return mode === 'off' ? 'Ambient listening is off.' : `Ambient listening is on (${mode}). I will stay quiet.`;
  },
});
