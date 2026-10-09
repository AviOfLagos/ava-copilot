import { describe, expect, it } from 'vitest';
import { isCallUrl, matchEvent } from '../autojoin';

const NOW = new Date(2026, 9, 9, 10, 0).getTime();
const event = (id: string, minutesFromNow: number, joinUrl: string | null = null, length = 30) => ({
  id,
  title: id,
  start: NOW + minutesFromNow * 60_000,
  end: NOW + (minutesFromNow + length) * 60_000,
  joinUrl,
});

describe('isCallUrl', () => {
  it('knows a call from a lobby or a home page', () => {
    expect(isCallUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(isCallUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(true);
    expect(isCallUrl('https://meet.google.com/')).toBe(false);
    expect(isCallUrl('https://meet.google.com/landing')).toBe(false);
    expect(isCallUrl('https://acme.zoom.us/wc/join/123456789')).toBe(true);
    expect(isCallUrl('https://zoom.us/wc/123456789/join')).toBe(true);
    expect(isCallUrl('https://zoom.us/signin')).toBe(false);
    expect(isCallUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting')).toBe(true);
    expect(isCallUrl('https://evil.example/meet.google.com/abc-defg-hij')).toBe(false);
  });
});

describe('matchEvent', () => {
  it('matches the event that carries the call link', () => {
    const events = [event('Other', 0), event('Stage 2 sync', 2, 'https://meet.google.com/abc-defg-hij')];
    expect(matchEvent('https://meet.google.com/abc-defg-hij', events, NOW)?.title).toBe('Stage 2 sync');
  });

  it('takes the one event starting about now when no link matches', () => {
    expect(matchEvent('https://meet.google.com/zzz-zzzz-zzz', [event('Standup', -3)], NOW)?.title).toBe('Standup');
  });

  it('asks rather than guess between two meetings, or when nothing is near', () => {
    expect(matchEvent('https://meet.google.com/zzz-zzzz-zzz', [event('A', 0), event('B', 5)], NOW)).toBeNull();
    expect(matchEvent('https://meet.google.com/zzz-zzzz-zzz', [event('Later', 120)], NOW)).toBeNull();
  });
});
