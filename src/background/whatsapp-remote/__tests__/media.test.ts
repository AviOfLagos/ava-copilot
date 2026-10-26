import { describe, expect, it } from 'vitest';
import { photoAttachment } from '../media';

const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));
const thumb = async () => new Blob(['thumb'], { type: 'image/jpeg' });

describe('a WhatsApp photo as a chat attachment', () => {
  it('keeps the picture whole with a small thumbnail, as the panel would', async () => {
    const attachment = await photoAttachment({ base64: jpeg, mediaType: 'image/jpeg', size: 4 }, thumb);
    expect(attachment).toMatchObject({ kind: 'image', name: 'WhatsApp photo', mediaType: 'image/jpeg', size: 4 });
    expect(new Uint8Array(await attachment.blob!.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(await attachment.thumb.text()).toBe('thumb');
  });

  it('refuses what is not a picture a chat takes, an empty one, and one over 10 MB', async () => {
    await expect(photoAttachment({ base64: jpeg, mediaType: 'image/heic', size: 4 }, thumb)).rejects.toThrow(
      /cannot be attached/,
    );
    await expect(photoAttachment({ base64: '', mediaType: 'image/jpeg', size: 0 }, thumb)).rejects.toThrow(/empty/);
    const big = 'A'.repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 8);
    await expect(photoAttachment({ base64: big, mediaType: 'image/png', size: 11e6 }, thumb)).rejects.toThrow(
      /over 10 MB/,
    );
  });
});
