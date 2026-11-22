import { describe, expect, it } from 'vitest';
import MessageManager from '../service';
import { systemMessage, userMessage } from '@src/background/llm/messages';

function managerWithSteps(steps: number): MessageManager {
  const manager = new MessageManager();
  manager.initTaskMessages(systemMessage('system'), 'Post the standup note');
  for (let i = 0; i < steps; i++) {
    manager.addModelOutput({ current_state: { memory: `step ${i}` }, action: [{ click_element: { index: i } }] });
  }
  return manager;
}

describe('MessageManager compaction', () => {
  it('replaces older steps with a summary, keeping the task, the init block and the recent steps', () => {
    const manager = managerWithSteps(10);
    manager.addNewTask('Also email Bob');
    for (let i = 10; i < 14; i++) {
      manager.addModelOutput({ current_state: { memory: `step ${i}` }, action: [] });
    }
    const before = manager.getMessages();

    const plan = manager.compactableMessages(4);
    expect(plan).not.toBeNull();
    // Task messages are never handed to the summarizer
    expect(JSON.stringify(plan!.messages)).not.toContain('Also email Bob');

    manager.compactHistory('Clicked through ten elements.', plan!.cut);
    const after = manager.getMessages();

    expect(after.length).toBeLessThan(before.length);
    expect(after[0]).toEqual(before[0]);
    const texts = after.map(m => JSON.stringify(m.content));
    expect(texts.some(text => text.includes('Post the standup note'))).toBe(true);
    expect(texts.some(text => text.includes('Also email Bob'))).toBe(true);
    expect(texts.some(text => text.includes('[Summary of earlier steps in this task]'))).toBe(true);
    expect(texts.some(text => text.includes('step 13'))).toBe(true);
    expect(texts.some(text => text.includes('step 2'))).toBe(false);
  });

  it('never starts the kept steps with a tool result, which would orphan it', () => {
    const manager = managerWithSteps(6);
    // Each step is a tool call followed by its result; an odd tail would start on a result
    const plan = manager.compactableMessages(3);
    manager.compactHistory('summary', plan!.cut);
    const after = manager.getMessages();
    const summaryIndex = after.findIndex(m => JSON.stringify(m.content).includes('[Summary of earlier steps'));
    expect(after[summaryIndex + 1]?.role).not.toBe('tool');
  });

  it('keeps token counts consistent after compacting', () => {
    const manager = managerWithSteps(8);
    const plan = manager.compactableMessages(2);
    manager.compactHistory('summary', plan!.cut);
    const fresh = new MessageManager();
    for (const message of manager.getMessages()) fresh.addMessageWithTokens(message);
    expect(manager.totalTokens()).toBe(fresh.totalTokens());
  });

  it('has nothing to compact in a short history', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(systemMessage('system'), 'task');
    expect(manager.compactableMessages(4)).toBeNull();
    manager.addMessageWithTokens(userMessage('one state'));
    expect(manager.compactableMessages(4)).toBeNull();
  });
});

describe('MessageManager clearing old action results (issue #132)', () => {
  const longResult = (i: number) => `Action result: Extracted from page ${i}: ${'lorem ipsum '.repeat(300)}`;

  function longRun(steps: number): MessageManager {
    const manager = managerWithSteps(0);
    for (let i = 0; i < steps; i++) {
      manager.addModelOutput({ current_state: { memory: `step ${i}` }, action: [{ extract: { index: i } }] });
      manager.addMessageWithTokens(userMessage(longResult(i)));
      manager.addMessageWithTokens(userMessage(`Action result: Clicked element ${i}`));
    }
    return manager;
  }

  it('shortens old long results to a line, and keeps the recent messages and the short results whole', () => {
    const manager = longRun(20);
    const before = manager.getMessages();
    const cleared = manager.clearOldActionResults(12);
    expect(cleared).toBeGreaterThan(4000);
    const after = manager.getMessages();
    expect(after).toHaveLength(before.length);
    const text = (message: { content: unknown }) => String(message.content);
    // An old long result is one line now
    const old = after.find(m => text(m).startsWith('Action result: Extracted from page 2:'))!;
    expect(text(old).length).toBeLessThan(400);
    expect(text(old)).toContain('characters cleared');
    // Short results stay whole, wherever they are
    expect(after.filter(m => text(m) === 'Action result: Clicked element 3')).toHaveLength(1);
    // The last 12 messages are untouched
    expect(after.slice(-12)).toEqual(before.slice(-12));
    // The task is untouched
    expect(JSON.stringify(after)).toContain('Post the standup note');
  });

  it('keeps the token count true, and does nothing a second time', () => {
    const manager = longRun(20);
    const full = manager.totalTokens();
    manager.clearOldActionResults(12);
    const fresh = new MessageManager();
    for (const message of manager.getMessages()) fresh.addMessageWithTokens(message);
    expect(manager.totalTokens()).toBe(fresh.totalTokens());
    expect(manager.totalTokens()).toBeLessThan(full * 0.5);
    expect(manager.clearOldActionResults(12)).toBe(0);
  });

  it('waits until enough results are old to be worth it, so the prompt start does not change every step', () => {
    const manager = longRun(4);
    expect(manager.clearOldActionResults(12)).toBe(0);
  });

  it('shows the saving on a 60-step run: the history carried on the last step', () => {
    const plain = longRun(60);
    const cleared = longRun(60);
    cleared.clearOldActionResults(12);
    const saved = 1 - cleared.totalTokens() / plain.totalTokens();
    // eslint-disable-next-line no-console
    console.log(
      `60-step run: ${plain.totalTokens()} → ${cleared.totalTokens()} history tokens (${Math.round(saved * 100)}% fewer)`,
    );
    expect(saved).toBeGreaterThan(0.7);
  });
});
