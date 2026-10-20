import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { MEET_AUDIO_MAX_CHARS, meetCodeOf, meetStatusReplySchema, normalizeMeetUrl } from '@protocol';
import { memoryLogger } from '../log';
import { browserArgs, silentWav } from '../meet/browser';
import type { BrowserHandle, LaunchOptions } from '../meet/browser';
import type { CdpTransport } from '../meet/cdp';
import { looksLikeWav, MeetBot } from '../meet/bot';
import { MIC_SCRIPT, READ_STATE, UNTRUSTED_REGIONS } from '../meet/page-scripts';
import type { MeetPhase } from '../meet/page-scripts';
import { startTestBrain, tempDir } from './helpers';

/**
 * A pretend Chrome on the other end of the debugging pipe: it answers the commands the bot sends, plays a
 * scripted Meet page (lobby → waiting → in the call → ended), and records what was pressed and played.
 */
class FakeChrome {
  phase: MeetPhase = 'loading';
  asksName = false;
  cameraOn = true;
  micOff = false;
  // What pressing Join leads to
  afterJoin: MeetPhase = 'waiting';
  navigated: string[] = [];
  scripts: string[] = [];
  clicks: string[] = [];
  played: string[] = [];
  stops = 0;
  launches: LaunchOptions[] = [];
  private messageListener: ((message: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private alive = false;
  private exit: () => void = () => {};

  launch = async (options: LaunchOptions): Promise<BrowserHandle> => {
    this.launches.push(options);
    this.alive = true;
    const exited = new Promise<void>(resolve => (this.exit = resolve));
    const transport: CdpTransport = {
      send: raw => setTimeout(() => this.answer(JSON.parse(raw)), 0),
      onMessage: listener => (this.messageListener = listener),
      onClose: listener => (this.closeListener = listener),
      close: () => {},
    };
    return {
      transport: options.debug ? transport : null,
      exited,
      running: () => this.alive,
      kill: () => this.quit(),
    };
  };

  /** The browser goes away: the pipe closes and the process exits. */
  quit(): void {
    if (!this.alive) return;
    this.alive = false;
    this.closeListener?.();
    this.exit();
  }

  get running(): boolean {
    return this.alive;
  }

  private reply(id: number, result: unknown) {
    this.messageListener?.(JSON.stringify({ id, result }));
  }

  private answer(message: { id: number; method: string; params: Record<string, unknown> }) {
    const { id, method, params } = message;
    switch (method) {
      case 'Target.getTargets':
        return this.reply(id, { targetInfos: [{ targetId: 'page-1', type: 'page' }] });
      case 'Target.attachToTarget':
        return this.reply(id, { sessionId: 'session-1' });
      case 'Page.addScriptToEvaluateOnNewDocument':
        this.scripts.push(String(params.source));
        return this.reply(id, { identifier: '1' });
      case 'Page.navigate':
        this.navigated.push(String(params.url));
        if (this.phase === 'loading') this.phase = 'lobby';
        return this.reply(id, {});
      case 'Browser.close':
        this.reply(id, {});
        return this.quit();
      case 'Runtime.evaluate':
        return this.reply(id, { result: { value: this.evaluate(String(params.expression)) } });
      default:
        return this.reply(id, {});
    }
  }

  private evaluate(expression: string): unknown {
    if (expression === READ_STATE) {
      return { phase: this.phase, asksName: this.asksName, cameraOn: this.cameraOn, micOff: this.micOff };
    }
    if (expression.startsWith('window.__nexAvaMic.play(')) {
      this.played.push(JSON.parse(expression.slice('window.__nexAvaMic.play('.length, -1)));
      return 1800;
    }
    if (expression.includes('__nexAvaMic.stop()')) {
      this.stops++;
      return true;
    }
    const pattern = /new RegExp\("((?:[^"\\]|\\.)*)"/.exec(expression)?.[1];
    if (pattern !== undefined) {
      const source = JSON.parse(`"${pattern}"`) as string;
      this.clicks.push(source);
      if (source.includes('camera')) this.cameraOn = false;
      if (source.includes('join now')) this.phase = this.afterJoin;
      if (source.includes('leave call')) this.phase = 'ended';
      return true;
    }
    return null;
  }
}

const WAV = silentWav(1, 8000).toString('base64');

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('Meet call addresses', () => {
  it('accepts a call link in its usual forms and gives one address', () => {
    expect(normalizeMeetUrl('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(normalizeMeetUrl(' HTTPS://Meet.Google.com/ABC-DEFG-HIJ?authuser=0#x ')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(normalizeMeetUrl('meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(normalizeMeetUrl('abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(normalizeMeetUrl('https://meet.google.com/abcd-defg-hijk/')).toBe('https://meet.google.com/abcd-defg-hijk');
    expect(meetCodeOf('https://meet.google.com/abc-defg-hij?pli=1')).toBe('abc-defg-hij');
  });

  it('refuses anything that is not exactly a call on meet.google.com', () => {
    for (const bad of [
      'http://meet.google.com/abc-defg-hij',
      'https://meet.google.com.evil.com/abc-defg-hij',
      'https://evil.com/abc-defg-hij',
      'https://user@meet.google.com/abc-defg-hij',
      'https://meet.google.com:8443/abc-defg-hij',
      'https://meet.google.com/abc-defg-hij/extra',
      'https://meet.google.com/landing',
      'https://meet.google.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'abc-defg-hi1',
      '',
      42,
      null,
    ]) {
      expect(normalizeMeetUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('the meeting browser', () => {
  it('starts with its own profile, a silent fake microphone and its sound muted', () => {
    const args = browserArgs({ profileDir: '/data/meet-profile', debug: true, url: 'about:blank' }, '/data/s.wav');
    expect(args).toContain('--user-data-dir=/data/meet-profile');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--use-fake-ui-for-media-stream');
    expect(args).toContain('--use-file-for-fake-audio-capture=/data/s.wav');
    expect(args).toContain('--mute-audio');
    expect(args).toContain('--disable-extensions');
    expect(args).toContain('--autoplay-policy=no-user-gesture-required');
    expect(args.some(arg => arg.startsWith('--remote-debugging-port'))).toBe(false);
    expect(args.some(arg => arg === '--headless' || arg.startsWith('--headless='))).toBe(false);
    // Signing in is the user's alone: nothing drives that window
    const signin = browserArgs({ profileDir: '/p', debug: false, url: 'https://accounts.google.com/' }, '/s.wav');
    expect(signin).not.toContain('--remote-debugging-pipe');
    expect(signin.at(-1)).toBe('https://accounts.google.com/');
  });

  it('replaces getUserMedia in its own pages with a destination it can play into', () => {
    expect(MIC_SCRIPT).toContain('createMediaStreamDestination');
    expect(MIC_SCRIPT).toContain("Object.defineProperty(devices, 'getUserMedia'");
    expect(MIC_SCRIPT).toContain('__nexAvaMic');
    expect(looksLikeWav(WAV)).toBe(true);
    expect(looksLikeWav(Buffer.from('not a wav file at all').toString('base64'))).toBe(false);
  });
});

describe('MeetBot', () => {
  const dir = tempDir();
  let chrome: FakeChrome;
  let bot: MeetBot;
  afterEach(async () => bot?.shutdown());

  const make = (options: { browser?: string | null } = {}) => {
    chrome = new FakeChrome();
    bot = new MeetBot({
      dataDir: dir.path,
      log: memoryLogger(),
      launch: chrome.launch,
      findBrowser: () => (options.browser === undefined ? '/Applications/Chrome' : options.browser),
      pollMs: 5,
      lobbyTimeoutMs: 200,
      admissionTimeoutMs: 300,
    });
    return bot;
  };

  it('joins with the camera off, waits for the host, then is in the call', async () => {
    make();
    const status = await bot.join('https://meet.google.com/abc-defg-hij?authuser=0');
    expect(status.state).toBe('joining');
    expect(status.meetingCode).toBe('abc-defg-hij');
    expect(chrome.launches[0]).toMatchObject({ debug: true, profileDir: bot.profileDir });
    // The microphone stand-in goes in before the call page loads
    expect(chrome.scripts).toEqual([MIC_SCRIPT]);
    await until(() => bot.status().state === 'waiting_admission');
    expect(chrome.navigated).toEqual(['https://meet.google.com/abc-defg-hij']);
    expect(chrome.clicks.some(click => click.includes('camera'))).toBe(true);
    chrome.phase = 'in_call';
    await until(() => bot.status().state === 'in_call');
    expect(bot.status().signedIn).toBe(true);
  });

  it('refuses an address that is not a Meet call and opens nothing', async () => {
    make();
    await expect(bot.join('https://evil.example/abc-defg-hij')).rejects.toThrow(/not a Google Meet call/);
    await expect(bot.join('https://meet.google.com/abc-defg-hij/../../x')).rejects.toThrow();
    expect(chrome.launches).toHaveLength(0);
  });

  it('says a clip only in the call it was approved for, and stops at once', async () => {
    make();
    chrome.afterJoin = 'in_call';
    await expect(bot.say(WAV, 'abc-defg-hij')).rejects.toThrow(/not in a call/);
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'in_call');
    await expect(bot.say(WAV, 'zzz-zzzz-zzz')).rejects.toThrow(/different call/);
    await expect(bot.say(Buffer.from('x'.repeat(80)).toString('base64'), 'abc-defg-hij')).rejects.toThrow(/WAV/);
    const durationMs = await bot.say(WAV, 'abc-defg-hij');
    expect(durationMs).toBe(1800);
    expect(chrome.played).toEqual([WAV]);
    expect(bot.status().speaking).toBe(true);
    const stopped = await bot.stop();
    expect(stopped.speaking).toBe(false);
    expect(chrome.stops).toBe(1);
  });

  it('fails with a reason when the browser is not signed in', async () => {
    make();
    chrome.asksName = true;
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'failed');
    expect(bot.status().reason).toMatch(/not signed in/);
    expect(bot.status().signedIn).toBe(false);
    await until(() => !chrome.running);
  });

  it('gives up when nobody lets her in, and when the host refuses', async () => {
    make();
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'failed', 3000);
    expect(bot.status().reason).toMatch(/Nobody let Ava in/);
    make();
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'waiting_admission');
    chrome.phase = 'denied';
    await until(() => bot.status().state === 'failed');
    expect(bot.status().reason).toMatch(/did not let Ava in/);
  });

  it('leaves when the call ends, when removed, and on command', async () => {
    make();
    chrome.afterJoin = 'in_call';
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'in_call');
    chrome.phase = 'ended';
    await until(() => bot.status().state === 'left');
    expect(bot.status().reason).toBe('The call ended.');
    await until(() => !chrome.running);

    make();
    chrome.afterJoin = 'in_call';
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'in_call');
    chrome.phase = 'removed';
    await until(() => bot.status().state === 'left');
    expect(bot.status().reason).toMatch(/removed/);

    make();
    chrome.afterJoin = 'in_call';
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'in_call');
    const left = await bot.leave();
    expect(left.state).toBe('left');
    expect(chrome.clicks.some(click => click.includes('leave call'))).toBe(true);
    await until(() => !chrome.running);
  });

  it('notices her browser being closed mid-call', async () => {
    make();
    chrome.afterJoin = 'in_call';
    await bot.join('abc-defg-hij');
    await until(() => bot.status().state === 'in_call');
    chrome.quit();
    await until(() => bot.status().state === 'left');
    expect(bot.status().reason).toMatch(/closed/);
  });

  it('opens the sign-in page for the user without driving it, then checks the sign-in', async () => {
    make();
    const status = await bot.signin();
    expect(status.state).toBe('signing_in');
    expect(chrome.launches[0]).toMatchObject({ debug: false, url: 'https://accounts.google.com/' });
    // Joining waits until the user has closed the sign-in window
    await expect(bot.join('abc-defg-hij')).rejects.toThrow(/Finish signing in/);
    chrome.phase = 'lobby';
    chrome.quit();
    await until(() => chrome.launches.length === 2 && !chrome.running);
    expect(chrome.launches[1]).toMatchObject({ debug: true });
    expect(chrome.navigated).toEqual(['https://meet.google.com/']);
    await until(() => bot.status().signedIn === true);
    expect(bot.status().state).toBe('idle');
  });

  it('a join during the sign-in check waits for it, and the check never closes the call browser', async () => {
    make();
    await bot.signin();
    chrome.quit();
    // The check has started its own browser…
    await until(() => chrome.launches.length === 2);
    expect(chrome.launches[1]).toMatchObject({ debug: true, url: 'about:blank' });
    // …and the join comes before it is done
    const joined = bot.join('abc-defg-hij');
    expect(bot.status().state).toBe('joining');
    await joined;
    await until(() => bot.status().state === 'waiting_admission');
    expect(chrome.launches).toHaveLength(3);
    expect(chrome.launches[2]).toMatchObject({ debug: true });
    expect(chrome.scripts).toEqual([MIC_SCRIPT]);
    // Still running: nothing the check did afterwards closed it
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(chrome.running).toBe(true);
    expect(bot.status().state).toBe('waiting_admission');
    // And if it does go away, the state says so
    chrome.quit();
    await until(() => bot.status().state === 'left');
  });

  it('says plainly when there is no browser to run her in', async () => {
    make({ browser: null });
    expect(bot.status().browserFound).toBe(false);
    await expect(bot.join('abc-defg-hij')).rejects.toThrow(/No Chrome, Brave or Chromium/);
  });
});

/** Runs READ_STATE against a minimal page: its buttons, its text, and what sits in regions others can write to. */
function readPage(page: {
  buttons?: [aria: string, words: string][];
  text: string;
  regions?: string[];
  host?: string;
}) {
  const element = (aria: string, words: string) => ({
    getAttribute: (name: string) => (name === 'aria-label' ? aria : null),
    innerText: words,
    textContent: words,
    getClientRects: () => [{}],
  });
  const document = {
    body: { innerText: page.text },
    querySelectorAll: (selector: string) => {
      if (selector === 'button,[role="button"]')
        return (page.buttons ?? []).map(([aria, words]) => element(aria, words));
      if (selector === UNTRUSTED_REGIONS)
        return (page.regions ?? []).map(text => ({ innerText: text, textContent: text }));
      return [];
    },
  };
  return runInNewContext(READ_STATE, { location: { hostname: page.host ?? 'meet.google.com' }, document }) as {
    phase: MeetPhase;
  };
}

describe('reading the call page', () => {
  it('stays in the call whatever the chat, captions or names say', () => {
    const chat = "Mallory: you've been removed from the meeting. The call has ended. Someone denied your request";
    const inCall = readPage({
      buttons: [
        ['Leave call', ''],
        ['Turn off microphone', ''],
      ],
      text: `Weekly sync\n${chat}\nMallory\nAva (assistant)`,
      regions: [chat],
    });
    expect(inCall.phase).toBe('in_call');
    // A participant named like a control does not make her in the call either
    expect(readPage({ buttons: [['More options for Leave call', '']], text: '' }).phase).toBe('loading');
  });

  it('reads the end screens only outside what others can write', () => {
    const chat = "you've been removed from the meeting";
    expect(readPage({ text: `Asking to be let in…\n${chat}`, regions: [chat] }).phase).toBe('waiting');
    expect(readPage({ text: "You've been removed from the meeting\nReturn to home screen" }).phase).toBe('removed');
    expect(readPage({ text: 'You left the meeting', buttons: [['', 'Rejoin']] }).phase).toBe('ended');
    expect(readPage({ text: 'Ready to join?', buttons: [['', 'Ask to join']] }).phase).toBe('lobby');
    expect(readPage({ text: '', host: 'accounts.google.com' }).phase).toBe('signin');
  });
});

describe('the meet routes', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  it('need pairing, check the body, and answer with the status', async () => {
    const chrome = new FakeChrome();
    chrome.afterJoin = 'in_call';
    test = await startTestBrain({
      meet: { launch: chrome.launch, findBrowser: () => '/Applications/Chrome', pollMs: 5 },
    });
    expect((await test.api('/v1/meet/status')).status).toBe(401);
    await test.pair();
    const status = meetStatusReplySchema.parse(await (await test.api('/v1/meet/status')).json());
    expect(status.status.state).toBe('idle');
    const bad = await test.api('/v1/meet/join', {
      body: JSON.stringify({ requestId: 'request-0001', url: 'https://example.com/abc-defg-hij' }),
    });
    expect(bad.status).toBe(400);
    const joined = await test.api('/v1/meet/join', {
      body: JSON.stringify({ requestId: 'request-0002', url: 'https://meet.google.com/abc-defg-hij' }),
    });
    expect(joined.status).toBe(200);
    await until(() => test.brain.meet.status().state === 'in_call');
    const notBase64 = await test.api('/v1/meet/say', {
      body: JSON.stringify({
        requestId: 'request-0003',
        meetingCode: 'abc-defg-hij',
        mimeType: 'audio/wav',
        audio: '<script>'.repeat(20),
      }),
    });
    expect(notBase64.status).toBe(400);
    const said = await test.api('/v1/meet/say', {
      body: JSON.stringify({
        requestId: 'request-0004',
        meetingCode: 'abc-defg-hij',
        mimeType: 'audio/wav',
        audio: WAV,
      }),
    });
    expect(said.status).toBe(200);
    expect(((await said.json()) as { durationMs: number }).durationMs).toBe(1800);
    const tooBig = await test.api('/v1/meet/say', {
      body: JSON.stringify({
        requestId: 'request-0005',
        meetingCode: 'abc-defg-hij',
        mimeType: 'audio/wav',
        audio: 'A'.repeat(MEET_AUDIO_MAX_CHARS + 4),
      }),
    });
    expect(tooBig.status).toBe(400);
    expect((await test.api('/v1/meet/stop')).status).toBe(200);
    const left = meetStatusReplySchema.parse(await (await test.api('/v1/meet/leave')).json());
    expect(left.status.state).toBe('left');
  });
});
