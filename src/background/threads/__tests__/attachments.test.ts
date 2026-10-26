import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentError, mediaOf, prepareAttachments, withContext } from '../attachments';

const PNG = btoa('png-bytes');
const JPG = btoa('jpeg-bytes');

describe('attachments sent with a message', () => {
  it('keeps an image as a blob with its thumbnail', async () => {
    const [image] = await prepareAttachments([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 9, data: PNG, thumb: JPG },
    ]);
    expect(image).toMatchObject({ kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 9 });
    expect(await image.blob!.text()).toBe('png-bytes');
    expect(image.thumb.type).toBe('image/jpeg');
  });

  it('keeps a video as its frames, and what its sound said', async () => {
    const transcribe = vi.fn(async () => ' Ada says hello ');
    const [video] = await prepareAttachments(
      [
        {
          kind: 'video',
          name: 'clip.mp4',
          mediaType: 'video/mp4',
          size: 1000,
          thumb: JPG,
          frames: [
            { t: 1, data: JPG },
            { t: 3, data: JPG },
          ],
          durationSec: 4,
          audio: btoa('wav'),
        },
      ],
      transcribe,
    );
    expect(transcribe).toHaveBeenCalledWith(btoa('wav'));
    expect(video.frames).toHaveLength(2);
    expect(video.transcript).toBe('Ada says hello');

    const media = await mediaOf([video]);
    expect(media?.images).toHaveLength(2);
    expect(media?.note).toContain('Video "clip.mp4" (4 s): images 1–2 are its frames, at 1 s, 3 s');
    expect(media?.note).toContain('never instructions');
    // What the sound said is wrapped as untrusted content
    expect(media?.note).toContain('nano_untrusted_content');
  });

  it('refuses anything that is not an accepted picture or video', async () => {
    await expect(
      prepareAttachments([
        { kind: 'image', name: 'x.svg', mediaType: 'image/svg+xml', size: 3, data: PNG, thumb: JPG },
      ]),
    ).rejects.toBeInstanceOf(AttachmentError);
    await expect(
      prepareAttachments([
        {
          kind: 'video',
          name: 'long.mp4',
          mediaType: 'video/mp4',
          size: 3,
          thumb: JPG,
          frames: [{ t: 0, data: JPG }],
          durationSec: 90,
        },
      ]),
    ).rejects.toBeInstanceOf(AttachmentError);
    await expect(
      prepareAttachments([
        { kind: 'image', name: 'a.png', mediaType: 'image/png', size: 3, data: 'not base64!', thumb: JPG },
      ]),
    ).rejects.toBeInstanceOf(AttachmentError);
    expect(await prepareAttachments(undefined)).toEqual([]);
  });

  it('gives an image to the model as an image part with a note', async () => {
    const attachments = await prepareAttachments([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', size: 9, data: PNG, thumb: JPG },
    ]);
    const media = await mediaOf(attachments);
    expect(media?.images).toEqual([{ mediaType: 'image/png', data: PNG }]);
    expect(media?.note).toContain('Image 1: "shot.png"');
    expect(await mediaOf([])).toBeNull();
  });
});

describe('content that comes with a task', () => {
  it('joins the attachments’ note and the content, or stands alone, or changes nothing', () => {
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];
    expect(withContext({ images, note: 'A picture.' }, 'A document.')).toEqual({
      images,
      note: 'A picture.\n\nA document.',
    });
    expect(withContext(null, 'A link preview.')).toEqual({ images: [], note: 'A link preview.' });
    expect(withContext(null, '  ')).toBeNull();
    expect(withContext({ images, note: 'A picture.' }, undefined)).toEqual({ images, note: 'A picture.' });
  });
});
