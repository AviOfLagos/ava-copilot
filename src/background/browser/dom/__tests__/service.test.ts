import { describe, expect, it } from 'vitest';
import { isExpectedGoneTargetError } from '../service';

describe('isExpectedGoneTargetError', () => {
  it('recognizes the chrome.scripting races for a tab or frame that is already gone', () => {
    expect(isExpectedGoneTargetError(new Error('No tab with id: 123'))).toBe(true);
    expect(isExpectedGoneTargetError(new Error('No frame with id 0 in tab 123'))).toBe(true);
    expect(isExpectedGoneTargetError(new Error('Frame with ID 7 was removed.'))).toBe(true);
    expect(isExpectedGoneTargetError(new Error('The tab was closed.'))).toBe(true);
  });

  it('treats anything else as a real error', () => {
    expect(isExpectedGoneTargetError(new Error('Cannot access a chrome:// URL'))).toBe(false);
    expect(isExpectedGoneTargetError(new Error('Unexpected failure'))).toBe(false);
    expect(isExpectedGoneTargetError('not an Error instance')).toBe(false);
  });
});
