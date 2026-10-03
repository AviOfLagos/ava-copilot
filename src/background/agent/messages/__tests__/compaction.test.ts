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
