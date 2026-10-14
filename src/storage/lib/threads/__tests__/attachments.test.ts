import { describe, expect, it } from 'vitest';
import { base64Bytes, checkAttachment, framePlan, kindOf, MAX_FRAMES, mediaTypeOf } from '../attachments';

const MB = 1024 * 1024;

describe('which files can be attached', () => {
  it('takes pictures and short videos by type, or by name when the type is missing', () => {
    expect(mediaTypeOf('a.png', 'image/png')).toBe('image/png');
    expect(mediaTypeOf('clip.MOV', '')).toBe('video/quicktime');
    expect(mediaTypeOf('photo.jpeg', 'application/octet-stream')).toBe('image/jpeg');
    expect(mediaTypeOf('notes.txt', 'text/plain')).toBeNull();
    expect(mediaTypeOf('icon.svg', 'image/svg+xml')).toBeNull();
    expect(kindOf('video/webm')).toBe('video');
    expect(kindOf('image/gif')).toBe('image');
  });

  it('accepts a picture up to 10 MB and refuses a bigger one', () => {
    expect(checkAttachment({ name: 'a.webp', type: 'image/webp', size: 10 * MB })).toEqual({
      ok: true,
      kind: 'image',
      mediaType: 'image/webp',
    });
    expect(checkAttachment({ name: 'a.webp', type: 'image/webp', size: 10 * MB + 1 })).toEqual({
      ok: false,
      problem: 'imageTooBig',
    });
  });

  it('accepts a video up to 50 MB and 60 seconds', () => {
    expect(checkAttachment({ name: 'v.mp4', type: 'video/mp4', size: 50 * MB, durationSec: 60.2 }).ok).toBe(true);
    expect(checkAttachment({ name: 'v.mp4', type: 'video/mp4', size: 50 * MB + 1 })).toEqual({
      ok: false,
      problem: 'videoTooBig',
    });
    expect(checkAttachment({ name: 'v.mp4', type: 'video/mp4', size: MB, durationSec: 61 })).toEqual({
      ok: false,
      problem: 'videoTooLong',
    });
  });

  it('refuses other files and more than six at once', () => {
    expect(checkAttachment({ name: 'x.pdf', type: 'application/pdf', size: 10 })).toEqual({
      ok: false,
      problem: 'type',
    });
    expect(checkAttachment({ name: 'a.png', type: 'image/png', size: 10 }, 6)).toEqual({
      ok: false,
      problem: 'tooMany',
    });
  });
});

describe('frames sampled from a video', () => {
  it('takes one every two seconds, from the middle of each interval', () => {
    expect(framePlan(10)).toEqual([1, 3, 5, 7, 9]);
  });

  it('spreads at most 16 across a long clip', () => {
    const plan = framePlan(60);
    expect(plan).toHaveLength(MAX_FRAMES);
    expect(plan[0]).toBeCloseTo(1.88, 2);
    expect(plan[plan.length - 1]).toBeLessThan(60);
    // Evenly spaced
    expect(plan[1] - plan[0]).toBeCloseTo(3.75, 2);
  });

  it('takes the middle frame of a clip shorter than two seconds, and the first of one with no length', () => {
    expect(framePlan(1.2)).toEqual([0.6]);
    expect(framePlan(0)).toEqual([0]);
    expect(framePlan(Number.NaN)).toEqual([0]);
  });
});

describe('base64 sizes', () => {
  it('counts the decoded bytes', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3);
    expect(base64Bytes(btoa('abcd'))).toBe(4);
    expect(base64Bytes(btoa('abcde'))).toBe(5);
  });
});
