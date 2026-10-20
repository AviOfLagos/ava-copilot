import { createLogger } from '../log';

/**
 * Moments worth telling the user about wherever he is, for features that reach him away from the panel (Ava on
 * WhatsApp). The places that already tell him (a desktop notification, a spoken line) also emit a notice here; a
 * sink decides whether and how to pass it on. Emitting never fails the caller and never waits for a sink.
 */

export type NoticeKind = 'approval' | 'meeting' | 'brief' | 'routine';

export interface Notice {
  kind: NoticeKind;
  // A short line: what is ready or waiting
  title: string;
  // More of it (the brief, a routine's result), plain text or markdown
  body?: string;
  // Same key, same notice: a sink sends one once
  key: string;
}

type Sink = (notice: Notice) => Promise<void> | void;

const logger = createLogger('Notices');
const sinks = new Map<string, Sink>();

export function registerNoticeSink(name: string, sink: Sink): void {
  sinks.set(name, sink);
}

export function emitNotice(notice: Notice): void {
  for (const [name, sink] of sinks) {
    try {
      void Promise.resolve(sink(notice)).catch(error => logger.warning(`Notice sink ${name} failed`, error));
    } catch (error) {
      logger.warning(`Notice sink ${name} failed`, error);
    }
  }
}
