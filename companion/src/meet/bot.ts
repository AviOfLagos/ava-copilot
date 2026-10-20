import { join } from 'node:path';
import { normalizeMeetUrl } from '@protocol';
import type { MeetState, MeetStatus } from '@protocol';
import { fail } from '../errors';
import type { Logger } from '../log';
import { findBrowser as findInstalledBrowser, launchBrowser } from './browser';
import type { BrowserHandle, LaunchBrowser } from './browser';
import { attachToPage, CdpConnection, evaluate } from './cdp';
import {
  clickExpression,
  CONTROLS,
  MIC_SCRIPT,
  playExpression,
  READ_STATE,
  SPEAKING_EXPRESSION,
  STOP_EXPRESSION,
} from './page-scripts';
import type { MeetReading } from './page-scripts';

/**
 * Ava as her own participant in a Google Meet call. One browser at a time, with its own profile under the
 * companion's data directory, signed in by the user by hand (this code never sees, types or keeps a password).
 *
 *   idle → joining → waiting_admission → in_call → left
 *                 ↘ failed(reason)   ↘ failed     ↘ (call ended, removed, browser closed, leave)
 *
 * While a call is on, a monitor reads the page about once a second: it presses Join (camera off, microphone
 * on), notices the host letting her in, and leaves when the call ends or she is removed. She speaks only when
 * the extension sends a clip (the user approved the exact words there), and stops at once on stop().
 */

export interface MeetBotDeps {
  dataDir: string;
  log: Logger;
  now?: () => number;
  launch?: LaunchBrowser;
  findBrowser?: () => string | null;
  // How often the page is read during a call
  pollMs?: number;
  // How long Meet gets to show its Join button
  lobbyTimeoutMs?: number;
  // How long she waits for the host to let her in
  admissionTimeoutMs?: number;
}

const ACTIVE: ReadonlySet<MeetState> = new Set(['joining', 'waiting_admission', 'in_call']);
const NOT_SIGNED_IN = 'Ava\'s browser is not signed in. Use "Sign Ava\'s browser in" first.';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Whether a base64 string starts like a WAV file (RIFF....WAVE). */
export function looksLikeWav(base64: string): boolean {
  try {
    const head = Buffer.from(base64.slice(0, 16), 'base64');
    return head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE';
  } catch {
    return false;
  }
}

export class MeetBot {
  private state: MeetState = 'idle';
  private reason: string | null = null;
  private code: string | null = null;
  private since: number;
  private signedIn: boolean | null = null;
  private browser: BrowserHandle | null = null;
  // What the open browser is for: the user signing in, a call, or a quick look at whether it is signed in
  private mode: 'signin' | 'call' | 'check' | null = null;
  private cdp: CdpConnection | null = null;
  private sessionId: string | null = null;
  private monitor: AbortController | null = null;
  // A sign-in check that is running
  private checking: Promise<boolean | null> | null = null;
  private speakingUntil = 0;
  private readonly now: () => number;
  private readonly launch: LaunchBrowser;
  private readonly findBrowser: () => string | null;
  readonly profileDir: string;

  constructor(private readonly deps: MeetBotDeps) {
    this.now = deps.now ?? Date.now;
    this.launch = deps.launch ?? launchBrowser;
    this.findBrowser = deps.findBrowser ?? (() => findInstalledBrowser());
    this.profileDir = join(deps.dataDir, 'meet-profile');
    this.since = this.now();
  }

  status(): MeetStatus {
    return {
      state: this.state,
      reason: this.reason,
      meetingCode: this.code,
      speaking: this.state === 'in_call' && this.now() < this.speakingUntil,
      signedIn: this.signedIn,
      browserFound: this.findBrowser() !== null,
      since: this.since,
    };
  }

  private set(state: MeetState, reason: string | null = null): void {
    if (state !== this.state || reason !== this.reason) this.since = this.now();
    this.state = state;
    this.reason = reason;
    if (state !== 'in_call') this.speakingUntil = 0;
  }

  private executable(): string {
    return (
      this.findBrowser() ?? fail('unavailable', 'No Chrome, Brave or Chromium was found on this Mac to run Ava in.')
    );
  }

  // ── Signing in (the user, by hand) ──

  /** Opens Ava's browser at Google's sign-in page for the user. Nothing here watches or drives that window. */
  async signin(): Promise<MeetStatus> {
    if (ACTIVE.has(this.state)) fail('invalid', 'Ava is in a call. Have her leave it first.');
    if (this.mode === 'signin' && this.browser?.running()) return this.status();
    await this.settleCheck();
    await this.closeBrowser();
    const browser = await this.launch({
      executable: this.executable(),
      profileDir: this.profileDir,
      debug: false,
      url: 'https://accounts.google.com/',
    });
    this.browser = browser;
    this.mode = 'signin';
    this.set('signing_in');
    void browser.exited.then(async () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.mode = null;
      this.set('idle');
      await this.checkSignedIn().catch(error =>
        this.deps.log.warn('Could not check the meeting browser sign-in', { error: (error as Error).message }),
      );
    });
    return this.status();
  }

  /**
   * Whether the profile is signed in: signed out, meet.google.com sends you to Google's product page or the
   * sign-in page; signed in, it stays on Meet. Runs the browser for a few seconds when nothing else uses it.
   */
  checkSignedIn(): Promise<boolean | null> {
    if (this.browser) return Promise.resolve(this.signedIn);
    if (!this.checking) {
      const check = this.runCheck();
      this.checking = check;
      void check
        .finally(() => {
          if (this.checking === check) this.checking = null;
        })
        .catch(() => {});
    }
    return this.checking;
  }

  private async runCheck(): Promise<boolean | null> {
    const browser = await this.launch({
      executable: this.executable(),
      profileDir: this.profileDir,
      debug: true,
      url: 'about:blank',
    });
    this.browser = browser;
    this.mode = 'check';
    try {
      const { cdp, sessionId } = await this.attach(browser, false);
      await cdp.send('Page.navigate', { url: 'https://meet.google.com/' }, { sessionId });
      let reading: MeetReading | null = null;
      for (let i = 0; i < 20; i++) {
        await pause(this.deps.pollMs ?? 750);
        reading = await evaluate<MeetReading>(cdp, sessionId, READ_STATE).catch(() => null);
        if (reading && reading.phase !== 'loading') break;
      }
      this.signedIn = reading ? reading.phase !== 'signin' && reading.phase !== 'elsewhere' : null;
      return this.signedIn;
    } finally {
      // Only its own browser: never one a join started meanwhile
      if (this.browser === browser) await this.closeBrowser();
    }
  }

  /** Waits for a sign-in check that is running, so nothing it does can touch what comes next. */
  private async settleCheck(): Promise<void> {
    await this.checking?.catch(() => {});
  }

  // ── A call ──

  /** Joins a call by its address. Only a strict https://meet.google.com/<code> is ever opened. */
  async join(input: string): Promise<MeetStatus> {
    const url = normalizeMeetUrl(input);
    if (!url) fail('invalid', 'That is not a Google Meet call link (https://meet.google.com/abc-defg-hij).');
    const code = url.slice('https://meet.google.com/'.length);
    if (ACTIVE.has(this.state)) {
      if (this.code === code) return this.status();
      fail('invalid', 'Ava is in another call. Have her leave it first.');
    }
    if (this.mode === 'signin' && this.browser?.running()) {
      fail('invalid', "Finish signing in, then close Ava's browser window and try again.");
    }
    const executable = this.executable();
    // Taken at once, so a second join while this one starts sees she is joining
    this.code = code;
    this.set('joining');
    try {
      await this.settleCheck();
      await this.closeBrowser();
      const browser = await this.launch({ executable, profileDir: this.profileDir, debug: true, url: 'about:blank' });
      this.browser = browser;
      this.mode = 'call';
      // However her browser goes away, the state says so
      void browser.exited.then(() => {
        if ((this.browser === browser || this.browser === null) && ACTIVE.has(this.state)) {
          void this.finish('left', "Ava's browser was closed.");
        }
      });
      const { cdp, sessionId } = await this.attach(browser, true);
      await cdp.send('Page.navigate', { url }, { sessionId });
      const monitor = new AbortController();
      this.monitor = monitor;
      void this.watch(monitor.signal);
    } catch (error) {
      await this.finish('failed', `Ava's browser did not start: ${(error as Error).message}`);
    }
    return this.status();
  }

  /** Connects to the browser's page; with the microphone stand-in installed before any page script runs. */
  private async attach(browser: BrowserHandle, withMic: boolean): Promise<{ cdp: CdpConnection; sessionId: string }> {
    if (!browser.transport) fail('unavailable', 'The meeting browser has no debugging pipe.');
    const cdp = new CdpConnection(browser.transport);
    this.cdp = cdp;
    cdp.onClose(() => {
      if (this.cdp !== cdp) return;
      this.cdp = null;
      this.sessionId = null;
      if (ACTIVE.has(this.state)) void this.finish('left', "Ava's browser was closed.");
    });
    const sessionId = await attachToPage(cdp);
    this.sessionId = sessionId;
    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    if (withMic) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MIC_SCRIPT }, { sessionId });
    return { cdp, sessionId };
  }

  /** Reads the call page until the call is over for her, pressing what joining needs. */
  private async watch(signal: AbortSignal): Promise<void> {
    const started = this.now();
    let joinPressedAt: number | null = null;
    let waitingSince: number | null = null;
    const pollMs = this.deps.pollMs ?? 1000;
    const lobbyTimeoutMs = this.deps.lobbyTimeoutMs ?? 60_000;
    const admissionTimeoutMs = this.deps.admissionTimeoutMs ?? 10 * 60_000;
    while (!signal.aborted) {
      await pause(pollMs);
      if (signal.aborted) return;
      const cdp = this.cdp;
      const sessionId = this.sessionId;
      if (!cdp || !sessionId) return;
      const reading = await evaluate<MeetReading>(cdp, sessionId, READ_STATE, 5000).catch(() => null);
      if (signal.aborted) return;
      const click = (pattern: RegExp) =>
        evaluate<boolean>(cdp, sessionId, clickExpression(pattern), 5000).catch(() => false);
      switch (reading?.phase) {
        case 'signin':
        case 'elsewhere':
          this.signedIn = false;
          return this.finish('failed', NOT_SIGNED_IN);
        case 'lobby':
          if (reading.asksName) {
            this.signedIn = false;
            return this.finish('failed', NOT_SIGNED_IN);
          }
          this.signedIn = true;
          if (joinPressedAt !== null && this.now() - joinPressedAt < 5000) break;
          if (reading.cameraOn) await click(CONTROLS.cameraOff);
          if (reading.micOff) await click(CONTROLS.micOn);
          if (await click(CONTROLS.join)) joinPressedAt = this.now();
          break;
        case 'waiting':
          waitingSince ??= this.now();
          if (this.state !== 'waiting_admission') this.set('waiting_admission');
          if (this.now() - waitingSince > admissionTimeoutMs) {
            return this.finish('failed', 'Nobody let Ava in, so she stopped asking.');
          }
          break;
        case 'in_call':
          this.signedIn = true;
          if (this.state !== 'in_call') {
            this.set('in_call');
            this.deps.log.info('Ava is in the call');
          }
          break;
        case 'ended':
          return this.finish('left', 'The call ended.');
        case 'removed':
          return this.finish('left', 'Someone removed Ava from the call.');
        case 'denied':
          return this.finish('failed', 'The host did not let Ava in.');
        default:
          if (this.state === 'joining' && this.now() - started > lobbyTimeoutMs) {
            return this.finish('failed', "Meet's Join button did not show in time.");
          }
      }
    }
  }

  /** Plays an approved clip into her microphone, in the call it was approved for; returns its length. */
  async say(audio: string, meetingCode: string): Promise<number> {
    if (this.state !== 'in_call' || !this.cdp || !this.sessionId) fail('invalid', 'Ava is not in a call.');
    if (meetingCode !== this.code) fail('forbidden', 'Ava is in a different call from the one this was meant for.');
    if (!looksLikeWav(audio)) fail('invalid', 'The audio is not a WAV file.');
    const durationMs = await evaluate<number>(this.cdp, this.sessionId, playExpression(audio), 30_000);
    const length = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
    this.speakingUntil = this.now() + length;
    return length;
  }

  /** Stops her mid-word. Safe at any time. */
  async stop(): Promise<MeetStatus> {
    this.speakingUntil = 0;
    if (this.cdp && this.sessionId) await evaluate(this.cdp, this.sessionId, STOP_EXPRESSION, 3000).catch(() => {});
    return this.status();
  }

  /** Whether the page says she is still speaking (the clip may have ended early). */
  async speaking(): Promise<boolean> {
    if (!this.cdp || !this.sessionId || this.state !== 'in_call') return false;
    return evaluate<boolean>(this.cdp, this.sessionId, SPEAKING_EXPRESSION, 3000).catch(() => false);
  }

  /** Leaves the call (pressing Leave so the others see her go) and closes her browser. */
  async leave(reason = 'Ava left the call.'): Promise<MeetStatus> {
    if (!ACTIVE.has(this.state)) {
      if (this.mode === 'call') await this.closeBrowser();
      return this.status();
    }
    await this.stop();
    if (this.cdp && this.sessionId && this.state === 'in_call') {
      await evaluate(this.cdp, this.sessionId, clickExpression(CONTROLS.leave), 3000).catch(() => false);
      await pause(Math.min(this.deps.pollMs ?? 1000, 1000));
    }
    await this.finish('left', reason);
    return this.status();
  }

  private async finish(state: 'left' | 'failed', reason: string): Promise<void> {
    this.monitor?.abort();
    this.monitor = null;
    this.set(state, reason);
    this.deps.log.info(state === 'left' ? 'Ava left the call' : 'Ava could not join', { reason });
    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    const cdp = this.cdp;
    this.browser = null;
    this.mode = null;
    this.cdp = null;
    this.sessionId = null;
    if (cdp && !cdp.isClosed) {
      await cdp.send('Browser.close', {}, { timeoutMs: 3000 }).catch(() => {});
      cdp.close();
    }
    if (browser?.running()) {
      browser.kill();
      await Promise.race([browser.exited, pause(5000)]);
    }
  }

  /** When Nex Brain stops: out of any call, browser closed. */
  async shutdown(): Promise<void> {
    if (ACTIVE.has(this.state)) await this.leave('Nex Brain stopped.');
    await this.closeBrowser();
  }
}
