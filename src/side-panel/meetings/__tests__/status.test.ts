import { describe, expect, it } from 'vitest';
import { captureOf } from '../status';

describe('captureOf', () => {
  it('says the meeting is hearing only once words came in', () => {
    expect(captureOf({ source: 'captions', captionsOn: true }, 3)).toBe('hearing');
    expect(captureOf({ source: 'audio' }, 1)).toBe('hearing');
  });

  it('never calls a meeting with no words "recording" as if all were well', () => {
    expect(captureOf({ source: 'audio' }, 0)).toBe('no_words');
    expect(captureOf({ source: 'captions', captionsOn: true }, 0)).toBe('waiting_captions');
    expect(captureOf({ source: 'captions', captionsOn: false }, 0)).toBe('captions_off');
    // No captions button found and none could be turned on
    expect(captureOf({ source: 'captions', captionsOn: null, warnings: ['captions_off'] }, 0)).toBe('captions_off');
    // Off Meet there is no captions button to read: it waits
    expect(captureOf({ source: 'captions' }, 0)).toBe('waiting_captions');
  });
});
