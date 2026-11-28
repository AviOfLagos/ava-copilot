import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../agent/types';
import { fitsRole } from '@extension/storage';
import type { ModelCatalogEntry } from '@extension/storage';
import { pictureCostUsd } from '../../llm/images';
import { priceText, sendPictureAction, sendPictureActionSchema } from '../picture';
import type { PictureDeps } from '../picture';

const context = { taskId: 'wa-thread', emitEvent: () => undefined } as unknown as AgentContext;
const input = (extra: Record<string, unknown> = {}) =>
  sendPictureActionSchema.schema.parse({ source: 'generate', description: 'A solar panel at sunset', ...extra });

function deps(overrides: Partial<PictureDeps> = {}) {
  const sent: Parameters<PictureDeps['send']>[0][] = [];
  const make = vi.fn(async () => ({ base64: 'iVBORw0KGgo=', mediaType: 'image/png' }));
  const all: PictureDeps = {
    origin: async () => 'whatsapp',
    replyTo: async () => 'wa-msg-1',
    screenshot: async () => '/9j/4AAQ',
    imageModel: async () => ({ label: 'gpt-image-1', costUsd: 0.042, local: false, make }),
    send: async request => void sent.push(request),
    ...overrides,
  };
  return { all, sent, make };
}

describe('send_whatsapp_picture (#204)', () => {
  it('says the price and makes nothing until he said yes', async () => {
    const { all, sent, make } = deps();
    const first = await sendPictureAction(context, input(), all);
    expect(first.extractedContent).toContain('about $0.04');
    expect(first.extractedContent).toContain('cost_ok true only after he says yes');
    expect(make).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    const second = await sendPictureAction(context, input({ cost_ok: true, caption: ' Sunset ' }), all);
    expect(second.error).toBeFalsy();
    expect(make).toHaveBeenCalledWith('A solar panel at sunset');
    expect(sent).toEqual([
      {
        media: 'image',
        data: 'iVBORw0KGgo=',
        mimetype: 'image/png',
        caption: 'Sunset',
        kind: 'reply',
        replyTo: 'wa-msg-1',
      },
    ]);
  });

  it('makes a picture with a local model without asking', async () => {
    const { all, sent } = deps({
      imageModel: async () => ({
        label: 'flux',
        costUsd: null,
        local: true,
        make: async () => ({ base64: 'AAAA', mediaType: 'image/png' }),
      }),
    });
    await sendPictureAction(context, input(), all);
    expect(sent).toHaveLength(1);
  });

  it('sends a screenshot of the page as a JPEG, free', async () => {
    const { all, sent } = deps();
    const result = await sendPictureAction(context, input({ source: 'screenshot', description: '' }), all);
    expect(result.extractedContent).toBe('Screenshot sent on WhatsApp.');
    expect(sent[0]).toMatchObject({ media: 'image', mimetype: 'image/jpeg', data: '/9j/4AAQ' });
  });

  it('refuses outside a WhatsApp chat, without a picture model, and without a description', async () => {
    expect((await sendPictureAction(context, input(), deps({ origin: async () => 'user' }).all)).error).toContain(
      'only works in a WhatsApp chat',
    );
    expect((await sendPictureAction(context, input(), deps({ imageModel: async () => null }).all)).error).toContain(
      'Models & usage',
    );
    expect((await sendPictureAction(context, input({ description: '  ' }), deps().all)).error).toContain('description');
  });

  it('says plainly when WhatsApp refused it', async () => {
    const { all } = deps({
      send: async () => {
        throw new Error('That picture is too big to send on WhatsApp.');
      },
    });
    const result = await sendPictureAction(context, input({ cost_ok: true }), all);
    expect(result.error).toContain('too big');
  });

  it('knows roughly what a picture costs, and says when it does not', () => {
    expect(pictureCostUsd('gpt-image-1')).toBe(0.042);
    expect(pictureCostUsd('gpt-image-1-mini')).toBe(0.011);
    expect(pictureCostUsd('gemini-2.5-flash-image')).toBe(0.039);
    expect(pictureCostUsd('some-new-model')).toBeNull();
    expect(priceText(0.011)).toBe('about $0.011');
    expect(priceText(0.134)).toBe('about $0.13');
    expect(priceText(null)).toContain('does not list');
  });

  it('gives the picture role only to models that make pictures', () => {
    const entry = (model: string, modalities: string[]) => ({ model, modalities, local: false }) as ModelCatalogEntry;
    expect(fitsRole(entry('gpt-image-1', ['image-output', 'text']), 'image')).toBe(true);
    expect(fitsRole(entry('gpt-5', ['chat', 'text', 'image']), 'image')).toBe(false);
  });
});
