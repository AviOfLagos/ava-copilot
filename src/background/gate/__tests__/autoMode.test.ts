import 'fake-indexeddb/auto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const { db, threadStore, gateSettingsStore } = await import('@extension/storage');
const { reviewAction } = await import('../review');
const { autoModeAllows } = await import('../autoMode');
const { markTainted, forgetTaint } = await import('../taint');
const { readCommitContent, readCommitEffect, readFocus } = await import('../probes');
const { ConfirmGate } = await import('../confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
const { DOMElementNode, DOMTextNode } = await import('../../browser/dom/views');
import type { ConfirmRequest } from '@extension/storage';
import type { AgentContext } from '../../agent/types';
import type Page from '../../browser/page';

/** Auto mode: the confirm gate lets a task through without cards, except where it must still ask. */

function fakePage(url = 'https://www.pinterest.com/pin/1'): Page {
  const content = { fields: [], context: '' };
  return {
    url: () => url,
    title: async () => 'Pin',
    evaluateInPage: async (fn: unknown) => {
      if (fn === readFocus) return { where: 'none', element: null };
      if (fn === readCommitContent) return content;
      if (fn === readCommitEffect) return { url, visible: [], pending: [] };
      throw new Error('unexpected probe');
    },
    locateElement: async () => ({ evaluate: async (fn: unknown) => (fn === readCommitContent ? content : 'Save') }),
  } as unknown as Page;
}

function button(label: string, attributes: Record<string, string> = {}, tagName = 'button') {
  const node = new DOMElementNode({ tagName, xpath: tagName, attributes, children: [], isVisible: true });
  node.children = [new DOMTextNode(label, true, node)];
  return node;
}

function fakeContext(threadId: string) {
  const confirmGate = new ConfirmGate();
  const requests: ConfirmRequest[] = [];
  const events: { state: string; details: string }[] = [];
  const context = {
    taskId: threadId,
    confirmGate,
    controller: new AbortController(),
    stop: vi.fn(async () => confirmGate.cancelAll()),
    markForm: vi.fn(),
    emitEvent: vi.fn(async (_actor: unknown, state: string, details: string) => {
      events.push({ state, details });
      if (state === ExecutionState.ACT_CONFIRM) {
        const request = JSON.parse(details) as ConfirmRequest;
        requests.push(request);
        setTimeout(() => confirmGate.answer(request.id, true));
      }
    }),
  };
  return { context: context as unknown as AgentContext, requests, events };
}

// `commits` is the model's own word that the click commits (a Save has no label the gate knows)
const click = (label: string, attributes?: Record<string, string>, commits = false) => ({
  action: 'click_element' as const,
  args: { index: 1, intent: label, commits },
  node: button(label, attributes),
});

async function chat(fields: Parameters<typeof threadStore.create>[0] = {}) {
  const thread = await threadStore.create({ origin: 'user', ...fields });
  await threadStore.update(thread.id, {
    status: 'running',
    taskRunId: `run-${thread.id}`,
    runStartedAt: Date.now() - 1,
  });
  return thread.id;
}

beforeEach(async () => {
  await db.doOnce.clear();
  forgetTaint();
});

describe('Auto mode on the confirm gate', () => {
  it('asks as usual while it is off', async () => {
    const { context, requests } = fakeContext(await chat());
    await reviewAction(context, fakePage(), click('Send'));
    expect(requests).toHaveLength(1);
  });

  it('lets a save go ahead with no card when it is on, and says so in the timeline', async () => {
    const id = await chat({ autoMode: true });
    const { context, requests, events } = fakeContext(id);
    const review = await reviewAction(context, fakePage(), click('Save', {}, true));
    expect(requests).toHaveLength(0);
    expect(review.proceed).toBe(true);
    expect(events.some(e => e.state === ExecutionState.ACT_START && e.details === 'gate_autoApproved')).toBe(true);
  });

  it('works in a chat that read outside content (a page), where no saved rule may answer', async () => {
    const id = await chat({ autoMode: true });
    await markTainted(id, 'page');
    const { context, requests } = fakeContext(id);
    const review = await reviewAction(context, fakePage(), click('Post'));
    expect(requests).toHaveLength(0);
    expect(review.proceed).toBe(true);
  });

  it('still asks for a payment, a purchase, deleting and access, even when it is on', async () => {
    const id = await chat({ autoMode: true });
    for (const label of ['Pay now', 'Buy now', 'Delete account', 'Grant access']) {
      const { context, requests } = fakeContext(id);
      await reviewAction(context, fakePage(), click(label));
      expect(requests.length, label).toBe(1);
    }
  });

  it('still hands a password to the user, even when it is on', async () => {
    const id = await chat({ autoMode: true });
    const { context, requests } = fakeContext(id);
    const typing = {
      action: 'input_text' as const,
      args: { index: 2, text: 'hunter2', intent: 'Enter the password' },
      node: button('', { type: 'password' }, 'input'),
    };
    const review = await reviewAction(context, fakePage(), typing);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.mode).toBe('needs_user');
    expect(review.proceed).toBe(false);
  });

  it('is never used by a chat nobody watches', async () => {
    for (const origin of ['agent', 'workflow', 'whatsapp'] as const) {
      const id = await chat({ origin, autoMode: true });
      expect(await autoModeAllows(id, 'send')).toBe(false);
    }
  });

  it('fails closed when the chat cannot be read', async () => {
    expect(await autoModeAllows('no-such-chat', 'send')).toBe(false);
  });
});

describe('who can turn Auto mode on', () => {
  const root = join(__dirname, '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  const sources = files(root).map(path => ({ path: path.slice(root.length + 1), text: readFileSync(path, 'utf8') }));

  it('is written to a chat only by the thread manager (the user-click command and the user setting)', () => {
    const writers = sources.filter(file => /\bautoMode\s*:/.test(file.text)).map(file => file.path);
    expect(writers).toEqual(['threads/manager.ts']);
  });

  it('is reachable only through the side panel port, never a runtime message a page or tool could send', () => {
    const using = sources.filter(file => file.text.includes("'thread_auto_mode'")).map(file => file.path);
    expect(using).toEqual(['index.ts']);
    const index = sources.find(file => file.path === 'index.ts')!.text;
    expect(index.indexOf('thread_auto_mode')).toBeGreaterThan(index.indexOf("port.name !== 'side-panel-connection'"));
    expect(index).toContain('message.on === true');
  });

  it('is not an argument any agent action takes', () => {
    const actions = sources.filter(
      file => file.path.startsWith('agent/actions') || file.path.startsWith('agent/tools'),
    );
    expect(actions.filter(file => /autoMode/i.test(file.text))).toEqual([]);
  });

  it('is off unless the user turned it on in settings', async () => {
    expect((await gateSettingsStore.getSettings()).autoModeDefault).toBe(false);
    await gateSettingsStore.setAutoModeDefault(true);
    expect((await gateSettingsStore.getSettings()).autoModeDefault).toBe(true);
    await gateSettingsStore.setConfirm('send', false);
    expect((await gateSettingsStore.getSettings()).autoModeDefault).toBe(true);
    await gateSettingsStore.setAutoModeDefault(false);
  });
});

describe('Auto mode and keys sent blind', () => {
  it('still asks for Enter when the focus cannot be read', async () => {
    const id = await chat({ autoMode: true });
    const { context, requests } = fakeContext(id);
    const page = {
      ...fakePage(),
      evaluateInPage: async (fn: unknown) => {
        if (fn === readFocus) return { where: 'frame', element: null };
        return { fields: [], context: '' };
      },
    } as unknown as Page;
    await reviewAction(context, page, { action: 'send_keys', args: { keys: 'Enter', intent: 'Submit' } });
    expect(requests).toHaveLength(1);
  });
});
