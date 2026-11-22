import { describe, expect, it } from 'vitest';
import { AgentContext } from '../types';

/**
 * "Mid-form or mid-send" (docs/growth-team.md, Part 1): a field typed into or a submit clicked in the last 3
 * steps. A tab closed at that point is not reopened blindly.
 */
const newContext = () => new AgentContext('thread-1', {} as never, {} as never, {} as never, {});

describe('whether a task is in the middle of a form', () => {
  it('is not, for a task that has only read and navigated', () => {
    const context = newContext();
    context.nSteps = 12;
    expect(context.isMidForm()).toBe(false);
  });

  it('is, in the step that typed or committed and while it is among the last 3 finished', () => {
    const context = newContext();
    context.nSteps = 5;
    context.markForm();
    // During step 8 the last three finished steps are 5, 6 and 7: still mid-form
    for (const step of [5, 6, 7, 8]) {
      context.nSteps = step;
      expect(context.isMidForm()).toBe(true);
    }
    context.nSteps = 9;
    expect(context.isMidForm()).toBe(false);
  });

  it('starts clean for the next task of the same chat, whose steps count from 0 again', () => {
    const context = newContext();
    context.nSteps = 6;
    context.markForm();
    // A finished executor is kept for follow-ups: "summarise this page" has typed nothing
    context.startTask();
    context.nSteps = 1;
    expect(context.isMidForm()).toBe(false);
  });

  it('goes by the latest touch, however many there were', () => {
    const context = newContext();
    for (let step = 0; step < 40; step++) {
      context.nSteps = step;
      context.markForm();
      context.markForm();
    }
    context.nSteps = 42;
    expect(context.isMidForm()).toBe(true);
    context.nSteps = 43;
    expect(context.isMidForm()).toBe(false);
  });
});

describe('what the model is told with the page state', () => {
  it('keeps a note until a step that was shown it goes through', () => {
    const context = newContext();
    context.notes.push('The tab was closed and reopened.');
    expect(context.readNotes()).toEqual(['The tab was closed and reopened.']);
    // The model call failed: the next state message shows it again
    expect(context.readNotes()).toEqual(['The tab was closed and reopened.']);
    // A note that arrives after the state was built is not lost with the ones the step saw
    context.notes.push('Another tab was reopened.');
    context.notesDelivered();
    expect(context.readNotes()).toEqual(['Another tab was reopened.']);
    context.notesDelivered();
    expect(context.readNotes()).toEqual([]);
  });
});
