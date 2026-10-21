import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(async () => {
  const { installChrome } = await import('./helpers');
  installChrome();
});

import { AviCopilotDb } from '@extension/storage';
import { buildSnapshot, parseSnapshot } from '../snapshot';
import { memoryArea } from './helpers';

// Words, so text compresses like text does
const WORDS =
  'the meeting agreed to ship invoice project review budget follow up with client next week draft proposal email ' +
  'calendar design research notes decision owner deadline browser agent model summary page link data team plan';
const words = WORDS.split(' ');
let seed = 7;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const text = (length: number) => {
  let out = '';
  while (out.length < length) out += `${words[Math.floor(random() * words.length)]} `;
  return out.slice(0, length);
};

/**
 * A realistic few months of use, to measure what a snapshot weighs: 200 chats of 40 messages, 30 meetings of
 * 300 transcript lines, 1000 knowledge items with 4000 embedded chunks (768 dimensions), a graph, and 100
 * image thumbnails. Prints the sizes; asserts only that it stays far under the 256 MB cap.
 */
describe('snapshot size', () => {
  it('measures a realistic fixture', async () => {
    const db = new AviCopilotDb(`size-${crypto.randomUUID()}`);
    const threads = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      title: text(40),
      updatedAt: i,
      status: 'idle',
      memory: text(600),
    }));
    await db.threads.bulkPut(threads as never);
    const messages = threads.flatMap(thread =>
      Array.from({ length: 40 }, (_, seq) => ({
        id: `${thread.id}-${seq}`,
        threadId: thread.id,
        seq,
        actor: seq % 2 ? 'navigator' : 'user',
        content: text(seq % 2 ? 900 : 160),
        ts: seq,
      })),
    );
    // A hundred messages carry a 15 KB thumbnail (JPEG bytes do not compress)
    for (let i = 0; i < 100; i++) {
      const bytes = new Uint8Array(15_000).map(() => Math.floor(random() * 256));
      Object.assign(messages[i * 70], {
        attachments: [
          {
            id: `a${i}`,
            kind: 'image',
            name: 'shot.jpg',
            mediaType: 'image/jpeg',
            size: 15_000,
            thumb: new Blob([bytes]),
          },
        ],
      });
    }
    await db.messages.bulkPut(messages as never);
    await db.meetings.bulkPut(
      Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        title: text(30),
        startedAt: i,
        status: 'done',
        markdown: text(3000),
      })) as never,
    );
    await db.segments.bulkPut(
      Array.from({ length: 30 * 300 }, (_, i) => ({
        id: `s${i}`,
        meetingId: `m${i % 30}`,
        tStart: i,
        tEnd: i + 5,
        speaker: 'Speaker 1',
        text: text(150),
        chunkIndex: i,
      })) as never,
    );
    await db.kbItems.bulkPut(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `k${i}`,
        sourceType: 'thread',
        sourceId: `t${i}`,
        title: text(40),
        updatedAt: i,
        sourceDate: i,
      })) as never,
    );
    const vector = () => {
      const values = Array.from({ length: 768 }, () => random() - 0.5);
      const norm = Math.hypot(...values);
      return values.map(value => value / norm);
    };
    await db.kbChunks.bulkPut(
      Array.from({ length: 4000 }, (_, i) => ({
        id: `c${i}`,
        itemId: `k${i % 1000}`,
        index: i,
        text: text(800),
        label: 'message 1',
        hash: `h${i}`,
        vector: vector(),
        embedModel: 'text-embedding-004',
      })) as never,
    );
    await db.graphNodes.bulkPut(
      Array.from({ length: 2000 }, (_, i) => ({
        id: `n${i}`,
        type: 'person',
        label: text(20),
        workspaceId: null,
        sourceItemIds: [`k${i % 1000}`],
        date: i,
        updatedAt: i,
      })) as never,
    );
    await db.graphEdges.bulkPut(
      Array.from({ length: 4000 }, (_, i) => ({
        id: `e${i}`,
        from: `n${i % 2000}`,
        to: `n${(i * 7) % 2000}`,
        kind: 'mentions',
        sourceItemId: `k${i % 1000}`,
      })) as never,
    );

    const started = Date.now();
    const built = await buildSnapshot({ db, storage: memoryArea({ settings: { a: 1 } }), extensionVersion: '0.2.0' });
    const ms = Date.now() - started;
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    console.info(
      `[backup size] JSON ${mb(built.jsonBytes)} MB, gzipped ${mb(built.bytes.length)} MB, built in ${ms} ms; ` +
        `counts ${JSON.stringify(built.counts)}`,
    );
    expect(built.bytes.length).toBeLessThan(64 * 1024 * 1024);
    const back = await parseSnapshot(built.bytes);
    expect(back.db.tables.kbChunks).toHaveLength(4000);
  }, 120_000);
});
