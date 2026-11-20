import { describe, expect, it } from 'vitest';
import { siteLabel, siteNamed, siteOf } from '../hint';

describe('siteOf and siteLabel', () => {
  it('gives the site a host belongs to', () => {
    expect(siteOf('app.slack.com')).toBe('slack.com');
    expect(siteOf('www.facebook.com')).toBe('facebook.com');
    expect(siteOf('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('shop.localhost')).toBe('shop.localhost');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
  });

  it('gives the name people call it by, and none for an address', () => {
    expect(siteLabel('app.slack.com')).toBe('slack');
    expect(siteLabel('mail.google.com')).toBe('google');
    expect(siteLabel('127.0.0.1')).toBe('');
  });
});

describe('siteNamed', () => {
  const open = ['facebook.com', 'app.slack.com', 'linear.app', 'medium.com', 'x.com'];

  it('finds the site a task names after a word that points at a place', () => {
    expect(siteNamed('Go to Facebook and reply to Ada', open)).toBe('facebook.com');
    expect(siteNamed('reply in Slack to the launch thread', open)).toBe('slack.com');
    expect(siteNamed('Open my Linear and list the bugs', open)).toBe('linear.app');
  });

  it('finds a written address, and prefers it to a name', () => {
    expect(siteNamed('check x.com for mentions', open)).toBe('x.com');
    expect(siteNamed('post on medium what app.slack.com says', open)).toBe('app.slack.com');
  });

  it('names nothing when no tab of that site is open', () => {
    expect(siteNamed('Go to Facebook and reply to Ada', ['linear.app'])).toBeNull();
    expect(siteNamed('open reddit.com', open)).toBeNull();
  });

  it('does not take a site whose name is only an ordinary word in the task', () => {
    expect(siteNamed('find linear algebra courses', open)).toBeNull();
    expect(siteNamed('write a medium length summary of the news', open)).toBeNull();
    expect(siteNamed('explain the notion of slack time', open)).toBeNull();
  });

  it('stays on the page in front when the task is about it', () => {
    expect(siteNamed('summarise this page and post it on Slack', open)).toBeNull();
    expect(siteNamed('fill in the form here, then check Facebook', open)).toBeNull();
  });

  it('takes the site named first when there are several', () => {
    expect(siteNamed('copy the note from Slack to Linear', open)).toBe('slack.com');
  });

  it('ignores file names and one or two letter names', () => {
    expect(siteNamed('open report.pdf', open)).toBeNull();
    expect(siteNamed('go to x and post', open)).toBeNull();
  });
});
