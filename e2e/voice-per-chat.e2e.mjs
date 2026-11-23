import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep, waitForThread } from './harness.mjs';

/**
 * Voice lives in a chat (docs/voice-per-chat.md): the mic in a chat talks there with its history, a task said out
 * loud runs in that same chat, leaving the tab pauses the conversation and coming back resumes it with "picking up
 * where we were", and the mic on a new chat starts one that knows the recent chats.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = { 'zebra-invoice': [done], 'pay-step': [done] };

let mock;
let extension;
let worker;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  worker = await (
    await extension.browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(extension.origin))
  ).worker();
  const providers = await extension.getStorage('llm-api-keys');
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ...providers.providers,
        gemini: { name: 'Gemini', type: 'gemini', apiKey: 'test-key', modelNames: ['gemini-3.8-flash'], createdAt: 1 },
      },
    },
    'voice-engine-settings': { mode: 'live', modeChosen: true },
    'meeting-settings': {
      liveModel: 'gemini-3.8-live',
      autoNotes: false,
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
  });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const readMessages = (page, threadId) =>
  page.evaluate(
    threadId =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('messages').objectStore('messages').getAll();
          all.onsuccess = () =>
            resolve(
              all.result
                .filter(message => message.threadId === threadId)
                .sort((a, b) => a.seq - b.seq)
                .map(message => ({ actor: message.actor, content: message.content })),
            );
          all.onerror = () => reject(all.error);
        };
      }),
    threadId,
  );

const voiceSessions = () => mock.live.sessions.filter(s => s.voice);
const instructionsOf = session => session.setups[0].systemInstruction.parts[0].text;

test('voice talks in the chat, runs its task there, pauses away from the tab and resumes on return', async () => {
  // A chat with some history, on the web tab's own panel
  mock.start('zebra-invoice');
  const session = await openSession(extension, mock);
  const tabId = await worker.evaluate(
    async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id,
    session.web.url(),
  );
  await session.panel.goto(`${extension.origin}/sidepanel.html?tab=${tabId}`);
  await session.panel.waitForSelector('textarea');
  await session.send('Run the scripted scenario zebra-invoice: check the zebra invoice total');
  // A new chat reads idle before its run starts: wait for the run's end first
  await session.waitForEnd();
  const chat = await waitForThread(session.panel, 'zebra-invoice', thread => thread.status === 'idle');
  const chatsBefore = (await readThreads(session.panel)).length;

  // The mic in that chat: the conversation knows the chat, and a task said out loud runs in it
  mock.live.voiceRequest = 'Now pay it';
  mock.live.voiceTool = {
    name: 'run_browser_task',
    args: { task: 'Run the scripted scenario pay-step: pay the zebra invoice' },
  };
  mock.start('pay-step');
  await session.web.bringToFront();
  await session.click('Talk to Ava');
  await waitFor(() => voiceSessions().length === 1, 'a voice session');
  assert.match(instructionsOf(voiceSessions()[0]), /check the zebra invoice total/);
  await waitFor(() => mock.live.toolResponses.length > 0, 'the task to start');
  assert.match(
    JSON.stringify(mock.live.toolResponses[0].response),
    /Started in this chat/,
    JSON.stringify((await readThreads(session.panel)).map(t => [t.id, t.title, t.status, t.voiceThreadId, t.tags])),
  );
  await waitFor(async () => {
    const messages = await readMessages(session.panel, chat.id);
    return messages.some(m => m.actor === 'user' && m.content.includes('pay the zebra invoice'));
  }, 'the task in the same chat');
  await waitFor(
    async () => (await readThreads(session.panel)).find(t => t.id === chat.id)?.status === 'idle',
    'the task to finish',
  );
  assert.equal((await readThreads(session.panel)).length, chatsBefore, 'no other chat was made');
  const spoken = await readMessages(session.panel, chat.id);
  assert.ok(
    spoken.some(m => m.actor === 'user' && m.content === 'Now pay it'),
    'the spoken words are in the chat',
  );

  // Another tab: the conversation pauses
  mock.live.voiceTool = { name: 'get_status', args: {} };
  const other = await extension.browser.newPage();
  await other.goto(`${mock.fixtureUrl}?other=1`);
  await other.bringToFront();
  await waitFor(() => voiceSessions()[0].closed, 'the session to close while away');
  await waitFor(async () => /Paused/.test(await session.panelText()), 'the panel to say Paused');

  // Back on the chat's tab: the same chat goes on, and Ava says she is picking up where they were
  await session.web.bringToFront();
  await waitFor(() => voiceSessions().length === 2, 'the conversation to resume');
  assert.match(instructionsOf(voiceSessions()[1]), /Now pay it/);
  await waitFor(
    async () =>
      (await readMessages(session.panel, chat.id)).some(
        m => m.actor === 'system' && m.content.startsWith('Voice is back'),
      ),
    'the chat to say voice is back',
  );
  await waitFor(() => mock.live.notices.some(n => /picking up where you were/.test(n)), 'the spoken pick-up');

  // The mic on a new chat: a new conversation that knows the recent chats; the old chat says where voice went
  await session.click('New thread');
  await sleep(500);
  // Voice is on in the other chat: this one's mic starts a conversation here, and voice moves
  await session.click('Talk to Ava');
  await waitFor(() => voiceSessions().length === 3, 'a new conversation');
  const fresh = instructionsOf(voiceSessions()[2]);
  assert.match(fresh, /most recent chats/);
  assert.match(fresh, /zebra/);
  await waitFor(
    async () =>
      (await readMessages(session.panel, chat.id)).some(
        m => m.actor === 'system' && m.content.startsWith('Voice moved'),
      ),
    'the old chat to say where voice went',
  );
  assert.equal(session.panelErrors.length, 0, session.panelErrors.join('\n'));
  await session.click('Stop talking').catch(() => {});
  await other.close();
});
