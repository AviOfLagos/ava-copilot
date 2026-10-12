import { z } from 'zod';
import { t } from '@extension/i18n';
import {
  db,
  localSttChoice,
  ttsSettingsStore,
  VOICE_MODEL_SIZES_MB,
  voiceEngineSettingsStore,
  voiceTtsEngine,
} from '@extension/storage';
import { toAppError } from '@extension/shared';
import { createLogger } from '../../log';
import { createRoleModel } from '../../models/roles';
import { registerCommand, registerOffscreenBusy, registerVoiceTool } from '../../registry';
import { services } from '../../registry/services';
import * as chromeEngine from '../../tts/chromeEngine';
import * as geminiEngine from '../../tts/geminiEngine';
import { isOverDailyBudget } from '../../usage/budget';
import { END_CONVERSATION, runEconomyTurn } from './economy';
import { isVoiceActivity, shouldEndIdle } from './idle';
import { localSpeaking, speakLocally } from './localTts';
import { forgetInstalledVoiceModels, installedVoiceModels } from './models';
import { askVoiceOffscreen, toVoiceOffscreen } from './offscreen';
import { chooseEconomyEngines, SETUP_COMMAND } from './options';
import { economyTurnRequest, systemSayRequest } from './protocol';
import type { EconomyTurnReply } from './protocol';
import type { VoiceEngineRuntimeStatus } from './wire';

/**
 * Wave 2 WS8, voice engines: the end_conversation voice tool, Settings › Voice engines' commands (status, "Say
 * something", a speech-to-text test, unload), the economy conversation's turns (text model + voice tools) and the
 * system voices it borrows, and the offscreen busy check for the local voices.
 */

const logger = createLogger('VoiceEngines');

// ── end_conversation ─────────────────────────────────────────────────────────────────────────────

registerVoiceTool({
  declaration: {
    name: END_CONVERSATION,
    description:
      'Ends this voice conversation. Call it when the user says goodbye, "that\'s all", "end the conversation" or "stop listening"; say nothing after it.',
  },
  // Free in every conversation (voice/guard.ts lists it): ending can never act for anyone
  guardLabel: 'end the conversation',
  handler: async () => {
    // After the tool answer is on its way, so the session ends cleanly
    setTimeout(
      () =>
        void services()
          .voice.stop()
          .catch(error => logger.warning('Ending failed', error)),
    );
    return 'The conversation is over. Say nothing more.';
  },
});

// ── Offscreen document ───────────────────────────────────────────────────────────────────────────

// Keeps the offscreen document open while a local voice speaks (read-aloud or the settings test)
registerOffscreenBusy('voice-engines', () => localSpeaking());

// ── Settings › Voice engines ─────────────────────────────────────────────────────────────────────

const requestOnly = (type: string) => z.object({ type: z.literal(type), requestId: z.string().optional() });

registerCommand('voice_engine_status', requestOnly('voice_engine_status'), async (_input, context) => {
  forgetInstalledVoiceModels();
  const [settings, tts, installed, runtime] = await Promise.all([
    voiceEngineSettingsStore.getSettings(),
    ttsSettingsStore.getSettings(),
    installedVoiceModels(),
    askVoiceOffscreen<VoiceEngineRuntimeStatus>({ type: 'voice_engine_runtime' }),
  ]);
  const economy = chooseEconomyEngines(settings, tts, installed);
  context.reply({
    type: 'voice_engine_status',
    requestId: context.requestId,
    installed,
    sizesMb: VOICE_MODEL_SIZES_MB,
    ttsEngine: voiceTtsEngine(tts.engine),
    economy: 'engines' in economy ? economy.engines : null,
    economyError: 'error' in economy ? economy.error : null,
    setupCommand: SETUP_COMMAND,
    runtime,
  });
});

registerCommand('voice_engine_test', requestOnly('voice_engine_test'), async (_input, context) => {
  const sentence = t('voice_engine_test_sentence');
  const started = Date.now();
  try {
    const [engine, tts] = await Promise.all([voiceEngineSettingsStore.getTtsEngine(), ttsSettingsStore.getSettings()]);
    const options = { voice: tts.voice || undefined, rate: tts.rate };
    let stats: Record<string, unknown> | undefined;
    if (engine === 'kitten' || engine === 'kokoro')
      stats = (await speakLocally(engine, sentence, { rate: tts.rate })).stats;
    else if (engine === 'gemini') await geminiEngine.speak(sentence, { rate: tts.rate });
    else await chromeEngine.speak(sentence, options);
    context.reply({
      type: 'voice_engine_test_ok',
      requestId: context.requestId,
      engine,
      ms: Date.now() - started,
      stats,
    });
  } catch (error) {
    context.reply({ type: 'error', requestId: context.requestId, error: toAppError(error).message });
  }
});

registerCommand('voice_engine_listen_test', requestOnly('voice_engine_listen_test'), async (_input, context) => {
  try {
    const stt = localSttChoice(await voiceEngineSettingsStore.getSettings(), await installedVoiceModels());
    if (!stt) throw new Error(t('voice_engine_models_missing', [SETUP_COMMAND]));
    const reply = await toVoiceOffscreen<{ ok?: boolean; error?: string; text?: string; ms?: number; loadMs?: number }>(
      { type: 'stt_listen_once', stt, timeoutMs: 15_000 },
    );
    if (!reply?.ok) throw new Error(reply?.error || t('voice_engine_listen_nothing'));
    context.reply({ type: 'voice_engine_listen_ok', requestId: context.requestId, ...stt, ...reply });
  } catch (error) {
    context.reply({ type: 'error', requestId: context.requestId, error: toAppError(error).message });
  }
});

registerCommand('voice_engine_unload', requestOnly('voice_engine_unload'), async (_input, context) => {
  await askVoiceOffscreen({ type: 'voice_engine_unload' });
  context.reply({ type: 'voice_engine_unload_ok', requestId: context.requestId });
});

// ── Idle end ─────────────────────────────────────────────────────────────────────────────────────

const IDLE_CHECK_MS = 15_000;
let lastActivity = Date.now();

// Only the extension's own documents count, never a content script in a web page
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && !sender.tab && isVoiceActivity(message)) lastActivity = Date.now();
  return;
});

async function idleCheck(): Promise<void> {
  const voice = services().voice;
  if (!voice.running) {
    // Nothing to end; a conversation that starts counts from now
    lastActivity = Date.now();
    return;
  }
  const { idleEndMinutes } = await voiceEngineSettingsStore.getSettings();
  const tasksBusy = (await db.threads.toArray()).some(
    thread => thread.status === 'running' || thread.status === 'waiting_confirm',
  );
  if (shouldEndIdle({ running: true, idleMinutes: idleEndMinutes, lastActivity, now: Date.now(), tasksBusy })) {
    logger.info(`Ending a voice conversation quiet for ${idleEndMinutes} minutes`);
    await voice.stop();
  }
}

// Runs while the background lives; a voice conversation keeps it alive, and with none this only resets the clock
setInterval(() => void idleCheck().catch(() => {}), IDLE_CHECK_MS);

// ── The economy conversation's turns ─────────────────────────────────────────────────────────────

/** Whether a message comes from the extension's offscreen document. */
function fromOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html');
}

async function economyTurn(message: unknown): Promise<EconomyTurnReply> {
  const parsed = economyTurnRequest.safeParse(message);
  if (!parsed.success) return { said: '', error: 'The turn was not valid.' };
  const voice = services().voice;
  // A conversation the background no longer runs (it restarted) answers nothing
  if (!voice.running) return { said: '', ended: true };
  const settings = await voiceEngineSettingsStore.getSettings();
  return runEconomyTurn(parsed.data, {
    model: async () => {
      const { chatModel, choice } = await createRoleModel(settings.economyModel, {
        sessionId: 'voice',
        notify: () => {},
      });
      return { chatModel, local: choice.local };
    },
    runTool: (name, args, heard) => voice.onTool(name, args, heard),
    overBudget: () => isOverDailyBudget(),
    capSentence: t('usage_capReached_short'),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('voice_engine_') || !fromOffscreen(sender)) {
    return;
  }
  switch (message.type) {
    case 'voice_engine_turn':
      economyTurn(message).then(sendResponse, error =>
        sendResponse({ said: '', error: toAppError(error).message } satisfies EconomyTurnReply),
      );
      return true;
    case 'voice_engine_system_say': {
      const parsed = systemSayRequest.safeParse(message);
      if (!parsed.success) {
        sendResponse({ ok: false, error: 'The request was not valid.' });
        return;
      }
      chromeEngine.speak(parsed.data.text, { rate: parsed.data.rate, voice: parsed.data.voice }).then(
        () => sendResponse({ ok: true }),
        error => sendResponse({ ok: false, error: toAppError(error).message }),
      );
      return true;
    }
    case 'voice_engine_system_stop':
      void chromeEngine.stop();
      return;
  }
  return;
});
