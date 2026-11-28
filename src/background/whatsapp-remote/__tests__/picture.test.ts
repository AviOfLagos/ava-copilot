import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../agent/types';
import { fitsRole } from '@extension/storage';
import type { ModelCatalogEntry } from '@extension/storage';
import { pictureCostUsd, pictureOptions } from '../../llm/images';
import { priceText, sendPictureAction, sendPictureActionSchema } from '../picture';
import type { PictureDeps } from '../picture';

const context = { taskId: 'wa-thread', emitEvent: () => undefined } as unknown as AgentContext;
const input = (extra: Record<string, unknown> = {}) =>
  sendPictureActionSchema.schema.parse({ source: 'generate', description: 'A solar panel at sunset', ...extra });

function deps(overrides: Partial<PictureDeps> = {}) {
  const sent: Parameters<PictureDeps['send']>[0][] = [];
  const make = vi.fn(async () => ({ base64: 'iVBORw0KGgo=', mediaType: 'image/png' }));
  // The message being answered: a new one each time he writes
  const chat = { replyTo: 'wa-msg-1', modelId: 'openai:gpt-image-1' };
  const all: PictureDeps = {
    origin: async () => 'whatsapp',
    replyTo: async () => chat.replyTo,
    screenshot: async () => '/9j/4AAQ',
    imageModel: async () => ({ id: chat.modelId, label: 'gpt-image-1', costUsd: 0.042, local: false, make }),
    send: async request => void sent.push(request),
    now: () => 1_000_000,
    quotes: new Map(),
    made: new Map(),
    ...overrides,
  };
  return { all, sent, make, chat };
}

describe('send_whatsapp_picture (#204)', () => {
  it('says the price and makes nothing until he said yes', async () => {
    const { all, sent, make, chat } = deps();
    const first = await sendPictureAction(context, input(), all);
    expect(first.extractedContent).toContain('about $0.04');
    expect(first.extractedContent).toContain('When he answers yes');
    expect(make).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    // cost_ok in the same turn, before he wrote anything: still only the price
    await sendPictureAction(context, input({ cost_ok: true }), all);
    expect(make).not.toHaveBeenCalled();

    // He wrote back ("yes"): now it is made
    chat.replyTo = 'wa-msg-2';

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
        replyTo: 'wa-msg-2',
      },
    ]);
  });

  it('never pays on cost_ok alone, nor for a model other than the one priced', async () => {
    const { all, make, chat } = deps();
    // No price was said in this chat
    expect((await sendPictureAction(context, input({ cost_ok: true }), all)).extractedContent).toContain(
      'Not made yet',
    );
    chat.replyTo = 'wa-msg-2';
    // The model changed between the price and his yes
    chat.modelId = 'openai:gpt-image-2';
    expect((await sendPictureAction(context, input({ cost_ok: true }), all)).extractedContent).toContain(
      'Not made yet',
    );
    expect(make).not.toHaveBeenCalled();
  });

  it('sends a paid picture again without paying again when the first send failed', async () => {
    let fails = true;
    const { all, make, sent, chat } = deps({
      send: async request => {
        if (fails) throw new Error('WhatsApp is not linked on your Mac.');
        sent.push(request);
      },
    });
    await sendPictureAction(context, input(), all);
    chat.replyTo = 'wa-msg-2';
    expect((await sendPictureAction(context, input({ cost_ok: true }), all)).error).toContain('not linked');
    fails = false;
    expect((await sendPictureAction(context, input({ cost_ok: true }), all)).error).toBeFalsy();
    expect(make).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('does not send a picture too big or of a kind WhatsApp cannot show', async () => {
    const { all, sent } = deps({
      imageModel: async () => ({
        id: 'local:x',
        label: 'x',
        costUsd: null,
        local: true,
        make: async () => ({ base64: 'R0lGODlh', mediaType: 'image/gif' }),
      }),
    });
    expect((await sendPictureAction(context, input(), all)).error).toContain('cannot show');
    expect(sent).toEqual([]);
  });

  it('asks OpenAI for the quality the price is for, as a small JPEG', () => {
    expect(pictureOptions('gpt-image-1')).toEqual({
      size: '1024x1024',
      providerOptions: { openai: { quality: 'medium', outputFormat: 'jpeg', outputCompression: 85 } },
    });
    expect(pictureOptions('imagen-4.0-generate-001')).toEqual({});
  });

  it('makes a picture with a local model without asking', async () => {
    const { all, sent } = deps({
      imageModel: async () => ({
        id: 'local:flux',
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
    const result = await sendPictureAction(context, input({ source: 'screenshot', description: '' }), all);
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
