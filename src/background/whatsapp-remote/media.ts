import { base64Bytes, IMAGE_TYPES, MAX_IMAGE_BYTES } from '@extension/storage';
import type { MessageAttachment } from '@extension/storage';

/**
 * A photo from WhatsApp as a chat attachment, the same as one picked in the panel: checked to be a picture a chat
 * takes and at most 10 MB, kept whole, with a small JPEG for the thread. What it shows is content to look at, never
 * instructions (see ../threads/attachments.ts).
 */

const THUMB_PX = 320;

const toBlob = (base64: string, type: string) =>
  new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type });

/** A small JPEG of a picture; the picture itself when it cannot be drawn here. */
export async function jpegThumb(image: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(image);
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } catch {
    return image;
  }
}

export async function photoAttachment(
  photo: { base64: string; mediaType: string; size: number },
  thumbOf: (image: Blob) => Promise<Blob> = jpegThumb,
): Promise<MessageAttachment> {
  const type = photo.mediaType.split(';')[0].trim().toLowerCase();
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new Error('This kind of picture cannot be attached.');
  if (!photo.base64) throw new Error('The photo came through empty.');
  if (base64Bytes(photo.base64) > MAX_IMAGE_BYTES) throw new Error('The photo is over 10 MB.');
  const blob = toBlob(photo.base64, type);
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    name: 'WhatsApp photo',
    mediaType: type,
    size: photo.size,
    thumb: await thumbOf(blob),
    blob,
  };
}
