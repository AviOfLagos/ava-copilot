import { describe, expect, it } from 'vitest';
import { isSideEffect, validateSpec } from '../spec';
import { browserJoinUrl, matchesUrlPattern, meetingKindOf, parseTabDetail, tabDetail } from '../tab-trigger';
import { isMeetingLinksRequest, meetingLinks, MEETING_LINK_PATTERNS, templateSpec } from '../templates';

const matchesAny = (url: string) => MEETING_LINK_PATTERNS.some(pattern => matchesUrlPattern(pattern, url));

describe('matchesUrlPattern', () => {
  it('matches meeting and calendar links', () => {
    expect(matchesAny('https://zoom.us/j/1234567890?pwd=abc')).toBe(true);
    expect(matchesAny('https://us05web.zoom.us/j/987654321')).toBe(true);
    expect(matchesAny('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(matchesAny('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(true);
    expect(matchesAny('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1')).toBe(true);
    expect(matchesAny('https://calendar.google.com/calendar/u/0/r/eventedit/abc123')).toBe(true);
    expect(matchesAny('https://calendar.google.com/calendar/event?eid=xyz')).toBe(true);
  });

  it('does not match home pages, other sites or look-alikes', () => {
    expect(matchesAny('https://meet.google.com/landing')).toBe(false);
    expect(matchesAny('https://zoom.us/')).toBe(false);
    expect(matchesAny('https://evilzoom.us/j/123')).toBe(false);
    expect(matchesAny('https://calendar.google.com/calendar/u/0/r/week')).toBe(false);
    expect(matchesAny('https://example.com/?next=meet.google.com/abc-defg-hij')).toBe(false);
    expect(matchesAny('chrome://settings')).toBe(false);
  });

  it('treats a pattern without a path as the whole site', () => {
    expect(matchesUrlPattern('x.com/*', 'https://www.x.com/home')).toBe(true);
    expect(matchesUrlPattern('x.com', 'https://x.com/')).toBe(true);
    expect(matchesUrlPattern('x.com', 'https://x.company.com/')).toBe(false);
  });
});

describe('the meeting-links routine', () => {
  it('is a valid workflow whose join step waits for the user’s click', () => {
    const check = validateSpec(meetingLinks());
    expect(check.ok).toBe(true);
    const join = meetingLinks().nodes.find(node => node.type === 'step.meeting_join')!;
    expect(isSideEffect(join)).toBe(true);
    expect(templateSpec('meeting_links', 'UTC').name).toBe('Meeting links');
  });

  it('is what the owner’s spoken request asks for', () => {
    expect(
      isMeetingLinksRequest(
        'set a hook that would always capture when there is a Zoom link in the browser, when there is a calendar link or a Google Meet link in the browser. And take action accordingly',
      ),
    ).toBe(true);
    expect(isMeetingLinksRequest('every morning at 7:30 check Hacker News')).toBe(false);
    expect(isMeetingLinksRequest('join my zoom call')).toBe(false);
  });

  it('carries the tab and address through the run, and joins Zoom in the browser', () => {
    expect(parseTabDetail(tabDetail(42, 'https://meet.google.com/abc-defg-hij'))).toEqual({
      tabId: 42,
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(parseTabDetail('panel')).toBeNull();
    expect(browserJoinUrl('https://us05web.zoom.us/j/123?pwd=x')).toBe('https://us05web.zoom.us/wc/join/123?pwd=x');
    expect(browserJoinUrl('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetingKindOf('https://calendar.google.com/calendar/event?eid=1')).toBe('calendar');
    expect(meetingKindOf('https://meet.google.com/landing')).toBeNull();
  });
});
