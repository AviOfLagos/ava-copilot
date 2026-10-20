import { join } from 'node:path';
import type { Logger } from '../log';
import { numberOfJid } from './driver';
import type { WaDriver, WaDriverFactory, WaEvents, WaIncoming } from './driver';

/**
 * The WhatsApp Web client: open-wa (@open-wa/wa-automate), which runs WhatsApp Web in a headless Chrome,
 * Brave or Chromium of its own (a separate profile under the session dir, never the user's). The user chose
 * this unofficial client and accepts that WhatsApp may restrict a number that uses one. Loaded only when a
 * session starts, so Nex Brain runs without it until WhatsApp is linked. Nothing here logs a message, a
 * number or the code to scan.
 */

const SESSION_ID = 'ava';

// The parts of open-wa this uses, typed loosely: its types are not part of the companion's contract
interface OpenWaClient {
  onAnyMessage(callback: (message: Record<string, unknown>) => void): unknown;
  onStateChanged?(callback: (state: string) => void): unknown;
  onLogout?(callback: (payload: { reason?: string }) => void): unknown;
  sendText(to: string, content: string): Promise<unknown>;
  getHostNumber?(): Promise<string>;
  getMe?(): Promise<Record<string, unknown>>;
  stop?(reason?: string): Promise<void>;
  kill?(reason?: string): Promise<unknown>;
}

interface OpenWaModule {
  create: (config: Record<string, unknown>) => Promise<OpenWaClient>;
  ev?: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
  };
}

const DATA_URL_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** A code from open-wa: the pairing string, or a picture of it as a data URL. Anything else is not a code. */
export function qrOf(value: unknown): string | null {
  const text =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? ((value as { details?: { qr?: unknown } }).details?.qr ?? (value as { qr?: unknown }).qr)
        : null;
  if (typeof text !== 'string' || !text || text.length > 200_000) return null;
  return text.startsWith('data:') ? (DATA_URL_IMAGE.test(text) ? text : null) : text;
}

const str = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as { _serialized?: unknown })._serialized === 'string'
      ? (value as { _serialized: string })._serialized
      : '';

/** An open-wa message as the service reads it. */
export function incomingOf(message: Record<string, unknown>): WaIncoming {
  const sender = (message.sender ?? {}) as Record<string, unknown>;
  const chatId =
    str(message.chatId) || str((message.chat as Record<string, unknown> | undefined)?.id) || str(message.from);
  const phone = typeof sender.phoneNumber === 'string' ? sender.phoneNumber.replace(/[^0-9]/g, '') : '';
  return {
    id: str(message.id),
    chatId,
    fromMe: message.fromMe === true,
    isGroup: message.isGroupMsg === true || chatId.endsWith('@g.us'),
    type: typeof message.type === 'string' ? message.type : 'unknown',
    body: typeof message.body === 'string' ? message.body : '',
    at: typeof message.t === 'number' ? message.t : typeof message.timestamp === 'number' ? message.timestamp : 0,
    senderNumber: numberOfJid(str(sender.id)) ?? numberOfJid(str(message.author)) ?? (phone.length >= 8 ? phone : null),
  };
}

/** Every id the account's own chat goes by, from what getMe returns. */
function selfIdsOf(me: Record<string, unknown> | undefined): string[] {
  if (!me) return [];
  const ids = new Set<string>();
  for (const value of Object.values(me)) {
    const id = str(value);
    if (/@(c\.us|s\.whatsapp\.net|lid)$/.test(id)) ids.add(id);
  }
  return [...ids];
}

export function openWaDriver(log: Logger, load: () => Promise<OpenWaModule> = loadOpenWa): WaDriverFactory {
  return options => {
    let client: OpenWaClient | null = null;
    let stopped = false;
    const listeners: [string, (...args: unknown[]) => void][] = [];
    let module: OpenWaModule | null = null;

    const driver: WaDriver = {
      async start(events: WaEvents) {
        module = await load();
        let lastQr = '';
        const onQr = (...args: unknown[]) => {
          // Aliases call (code, sessionId); native events (event, sessionId)
          if (stopped || (typeof args[1] === 'string' && args[1] !== SESSION_ID)) return;
          const code = qrOf(args[0]);
          if (code && code !== lastQr) {
            lastQr = code;
            events.qr(code);
          }
        };
        for (const name of ['qr.**', 'launch.auth.qr.generated']) {
          module.ev?.on(name, onQr);
          listeners.push([name, onQr]);
        }
        const config = {
          sessionId: SESSION_ID,
          sessionDataPath: options.sessionDir,
          userDataDir: join(options.sessionDir, 'browser'),
          ...(options.executablePath ? { executablePath: options.executablePath } : { useChrome: true }),
          headless: true,
          multiDevice: true,
          // Wait for a scan for three minutes; a new code shows every 20 s or so meanwhile
          qrTimeout: 180,
          authTimeout: 180,
          qrLogSkip: true,
          logConsole: false,
          logConsoleErrors: false,
          disableSpins: true,
          popup: false,
          skipUpdateCheck: true,
          // Never end Nex Brain's own process
          killProcessOnBrowserClose: false,
          killProcessOnTimeout: false,
          killProcessOnBan: false,
          throwErrorOnTosBlock: true,
        };
        // Linking waits for the scan; start returns at once and the rest arrives as events
        void module
          .create(config)
          .then(async created => {
            if (stopped) {
              await (created.stop?.('stopped') ?? created.kill?.('stopped'))?.catch?.(() => {});
              return;
            }
            client = created;
            created.onAnyMessage(message => {
              if (!stopped) events.message(incomingOf(message));
            });
            created.onStateChanged?.(state => {
              if (stopped) return;
              if (state === 'CONNECTED') return;
              if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'UNPAIRED_IDLE', 'DEPRECATED_VERSION'].includes(state)) {
                events.disconnected(`WhatsApp says ${state.toLowerCase().replace(/_/g, ' ')}.`);
              }
            });
            created.onLogout?.(() => {
              if (!stopped) events.disconnected('This Mac was removed from Linked devices on your phone.');
            });
            const me = await created.getMe?.().catch(() => undefined);
            const host = (await created.getHostNumber?.().catch(() => '')) ?? '';
            const number = numberOfJid(host) ?? host.replace(/[^0-9]/g, '') ?? '';
            const fromMe = numberOfJid(str((me as { me?: unknown } | undefined)?.me));
            events.ready({ number: number || fromMe || '', selfIds: selfIdsOf(me) });
          })
          .catch(error => {
            if (stopped) return;
            log.warn('WhatsApp did not link', { error: (error as Error)?.name ?? 'Error' });
            events.failed('Linking did not finish. Start again and scan the new code within three minutes.');
          });
      },
      async sendText(chatId, text) {
        if (!client) throw new Error('WhatsApp is not linked.');
        const result = await client.sendText(chatId, text);
        return typeof result === 'string' ? result : str(result) || null;
      },
      async stop() {
        stopped = true;
        for (const [name, listener] of listeners) module?.ev?.off?.(name, listener);
        listeners.length = 0;
        const current = client;
        client = null;
        if (current) await (current.stop?.('stopped') ?? current.kill?.('stopped'));
      },
    };
    return driver;
  };
}

async function loadOpenWa(): Promise<OpenWaModule> {
  const loaded = (await import('@open-wa/wa-automate')) as unknown as OpenWaModule & { default?: OpenWaModule };
  const module = typeof loaded.create === 'function' ? loaded : loaded.default;
  if (!module || typeof module.create !== 'function') throw new Error('The WhatsApp client is not installed.');
  return module;
}
