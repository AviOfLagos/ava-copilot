import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { privateDir } from '../config';
import type { CdpTransport } from './cdp';

/**
 * Ava's meeting browser: the user's own Chrome, Brave or Chromium, started as a separate program with a profile
 * of its own (the dedicated account the user signs in to by hand; never the user's profile). No extensions, no
 * real camera or microphone, its sound muted (the call would otherwise play out of the Mac's speakers and echo
 * into the user's microphone). Driven over Chrome's debugging pipe, so no port is open for anything else.
 */

export const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** The browser to run Ava in: AVI_BRAIN_MEET_BROWSER when set and present, else the first one installed. */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const chosen = env.AVI_BRAIN_MEET_BROWSER;
  if (chosen) return exists(chosen) ? chosen : null;
  return BROWSER_CANDIDATES.find(path => exists(path)) ?? null;
}

/** One second of silence, 16 kHz mono: what the browser's fake capture device plays if anything gets past the wrapper. */
export function silentWav(seconds = 1, sampleRate = 16_000): Buffer {
  const samples = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

export interface LaunchOptions {
  executable: string;
  profileDir: string;
  // Driven by the companion (a call), or left to the user (signing in): no debugging pipe at all then
  debug: boolean;
  url: string;
}

/** The command line, apart from the executable. Kept separate so a test can read it. */
export function browserArgs(options: Omit<LaunchOptions, 'executable'>, silentFile: string): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--password-store=basic',
    '--window-size=720,560',
    '--autoplay-policy=no-user-gesture-required',
    ...(options.debug
      ? [
          '--remote-debugging-pipe',
          // The call's sound stays in this browser: played on the Mac, it would echo into the user's microphone
          '--mute-audio',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${silentFile}`,
        ]
      : []),
    '--new-window',
    options.url,
  ];
}

export interface BrowserHandle {
  // Present when started with debug
  transport: CdpTransport | null;
  exited: Promise<void>;
  running(): boolean;
  kill(): void;
}

export type LaunchBrowser = (options: LaunchOptions) => Promise<BrowserHandle>;

/** A transport over the debugging pipe: the browser reads fd 3 and writes fd 4, one NUL after each message. */
export function pipeTransport(toBrowser: Writable, fromBrowser: Readable): CdpTransport {
  const messageListeners = new Set<(message: string) => void>();
  const closeListeners = new Set<() => void>();
  let pending = '';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', (chunk: string) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\0')) >= 0) {
      const message = pending.slice(0, end);
      pending = pending.slice(end + 1);
      for (const listener of messageListeners) listener(message);
    }
  });
  fromBrowser.on('close', close);
  fromBrowser.on('error', close);
  toBrowser.on('error', close);
  return {
    send: message => {
      if (!closed) toBrowser.write(`${message}\0`);
    },
    onMessage: listener => void messageListeners.add(listener),
    onClose: listener => void closeListeners.add(listener),
    close: () => {
      toBrowser.end();
      close();
    },
  };
}

/** Starts the browser. Its output is not read: it can hold page addresses, and nothing in it is needed. */
export const launchBrowser: LaunchBrowser = async options => {
  privateDir(options.profileDir);
  const silentFile = join(options.profileDir, 'silence.wav');
  if (!existsSync(silentFile)) writeFileSync(silentFile, silentWav(), { mode: 0o600 });
  const child: ChildProcess = spawn(options.executable, browserArgs(options, silentFile), {
    stdio: options.debug ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    detached: false,
  });
  let alive = true;
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => {
      alive = false;
      resolve();
    });
    child.once('error', () => {
      alive = false;
      resolve();
    });
  });
  const transport = options.debug ? pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable) : null;
  return {
    transport,
    exited,
    running: () => alive,
    kill: () => {
      if (alive) child.kill('SIGTERM');
    },
  };
};
