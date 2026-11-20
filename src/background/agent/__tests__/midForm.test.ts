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

  it('is, in the step that typed or committed and the two after it', () => {
    const context = newContext();
    context.nSteps = 5;
    context.markForm();
    for (const step of [5, 6, 7]) {
      context.nSteps = step;
      expect(context.isMidForm()).toBe(true);
    }
    context.nSteps = 8;
    expect(context.isMidForm()).toBe(false);
  });

  it('goes by the latest touch, however many there were', () => {
    const context = newContext();
    for (let step = 0; step < 40; step++) {
      context.nSteps = step;
      context.markForm();
      context.markForm();
    }
    context.nSteps = 41;
    expect(context.isMidForm()).toBe(true);
    context.nSteps = 42;
    expect(context.isMidForm()).toBe(false);
  });
});
