import { describe, expect, it } from 'vitest';
import { PendingSends } from '../pendingSends';

describe('PendingSends', () => {
  it('gives back the words of a send the background refused, once', () => {
    const sends = new PendingSends();
    sends.add('a', 'send the invoice to Ada');
    expect(sends.fail('a')).toBe('send the invoice to Ada');
    expect(sends.fail('a')).toBeNull();
  });

  it('keeps nothing once the background took the message', () => {
    const sends = new PendingSends();
    sends.add('a', 'hello');
    sends.confirm('a');
    expect(sends.fail('a')).toBeNull();
    expect(sends.failAll()).toBeNull();
  });

  it('gives back every waiting message when the connection breaks', () => {
    const sends = new PendingSends();
    sends.add('a', 'first');
    sends.add('b', 'second');
    sends.add('c', '   ');
    expect(sends.failAll()).toBe('first\n\nsecond');
    expect(sends.failAll()).toBeNull();
    expect(sends.fail(undefined)).toBeNull();
  });
});
