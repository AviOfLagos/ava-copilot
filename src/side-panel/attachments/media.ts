import { checkAttachment, framePlan, speechToTextModelStore } from '@extension/storage';
import type { AttachmentProblem, OutgoingAttachment } from '@extension/storage';
import { bytesToBase64, encodeWav, hasSound, toMono } from './wav';

/**
 * Reads a picture or a short video the user attached, in the panel (it has a document for <video> and canvas):
 * an image as the model will see it, a video as frames every two seconds plus its sound for the speech model.
 * Nothing leaves the panel here; the background gets the result over the port.
 */

// The longest side of an image sent to a model; larger ones are scaled down
const MODEL_IMAGE_SIDE = 2048;
// Images smaller than this in bytes and side are sent as they are
const KEEP_AS_IS_BYTES = 4 * 1024 * 1024;
const FRAME_SIDE = 768;
const THUMB_SIDE = 160;
const AUDIO_RATE = 16_000;

export class AttachmentReadError extends Error {
  constructor(public readonly problem: AttachmentProblem | 'unreadable') {
    super(problem);
  }
}

/** One attachment in the composer: shown as a thumbnail, sent as `outgoing`. */
export interface PendingAttachment {
  id: string;
  name: string;
  kind: 'image' | 'video';
  // An object URL of the thumbnail; revoke it when removed
  preview: string;
  durationSec?: number;
  outgoing: OutgoingAttachment;
}

function canvasFor(width: number, height: number, side: number) {
  const scale = Math.min(1, side / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new AttachmentReadError('unreadable'))), type, quality),
  );

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Draws `source` scaled to fit `side`, as a JPEG. */
async function jpegOf(source: CanvasImageSource, width: number, height: number, side: number, quality: number) {
  const canvas = canvasFor(width, height, side);
  const context = canvas.getContext('2d');
  if (!context) throw new AttachmentReadError('unreadable');
  // Transparent pictures get a white background rather than black
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas, 'image/jpeg', quality);
}

async function readImage(file: File, mediaType: string): Promise<PendingAttachment> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new AttachmentReadError('unreadable');
  });
  try {
    const thumb = await jpegOf(bitmap, bitmap.width, bitmap.height, THUMB_SIDE, 0.8);
    // A GIF is sent as its first frame; a big picture is scaled down; the rest go as they are
    const keep =
      mediaType !== 'image/gif' &&
      file.size <= KEEP_AS_IS_BYTES &&
      Math.max(bitmap.width, bitmap.height) <= MODEL_IMAGE_SIDE;
    const forModel = keep ? file : await jpegOf(bitmap, bitmap.width, bitmap.height, MODEL_IMAGE_SIDE, 0.9);
    return {
      id: crypto.randomUUID(),
      name: file.name,
      kind: 'image',
      preview: URL.createObjectURL(thumb),
      outgoing: {
        kind: 'image',
        name: file.name,
        mediaType: keep ? mediaType : 'image/jpeg',
        size: file.size,
        data: await blobToBase64(forModel),
        thumb: await blobToBase64(thumb),
      },
    };
  } finally {
    bitmap.close();
  }
}

function once(target: HTMLMediaElement, event: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AttachmentReadError('unreadable')), timeoutMs);
    const done = () => {
      window.clearTimeout(timer);
      target.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      window.clearTimeout(timer);
      reject(new AttachmentReadError('unreadable'));
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

/** A video's sound at 16 kHz mono, as WAV base64; undefined when it has none or it cannot be decoded. */
async function soundOf(file: File, durationSec: number): Promise<string | undefined> {
  try {
    const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(durationSec * AUDIO_RATE)), AUDIO_RATE);
    // Decoding resamples to the context's rate
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const mono = toMono(channels);
    if (!hasSound(mono)) return undefined;
    return bytesToBase64(encodeWav(mono, AUDIO_RATE));
  } catch {
    return undefined;
  }
}

async function readVideo(file: File, mediaType: string): Promise<PendingAttachment> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    video.src = url;
    await once(video, 'loadeddata');
    const durationSec = video.duration;
    const checked = checkAttachment({ name: file.name, type: mediaType, size: file.size, durationSec });
    if (!checked.ok) throw new AttachmentReadError(checked.problem);
    const frames: { t: number; data: string }[] = [];
    let thumb: Blob | null = null;
    for (const t of framePlan(durationSec)) {
      video.currentTime = t;
      await once(video, 'seeked');
      const frame = await jpegOf(video, video.videoWidth, video.videoHeight, FRAME_SIDE, 0.75);
      thumb ??= await jpegOf(video, video.videoWidth, video.videoHeight, THUMB_SIDE, 0.8);
      frames.push({ t, data: await blobToBase64(frame) });
    }
    if (!thumb) throw new AttachmentReadError('unreadable');
    // The sound is written down only when a speech model is set; otherwise it never leaves the panel
    const speech = await speechToTextModelStore.getSpeechToTextModel().catch(() => undefined);
    const audio = speech?.provider && speech.modelName ? await soundOf(file, durationSec) : undefined;
    return {
      id: crypto.randomUUID(),
      name: file.name,
      kind: 'video',
      preview: URL.createObjectURL(thumb),
      durationSec,
      outgoing: {
        kind: 'video',
        name: file.name,
        mediaType,
        size: file.size,
        thumb: await blobToBase64(thumb),
        frames,
        durationSec: Math.round(durationSec * 100) / 100,
        ...(audio ? { audio } : {}),
      },
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Reads one picked file as an attachment.
 *
 * @throws AttachmentReadError saying what is wrong with it
 */
export async function readAttachment(file: File, alreadyAttached: number): Promise<PendingAttachment> {
  const checked = checkAttachment({ name: file.name, type: file.type, size: file.size }, alreadyAttached);
  if (!checked.ok) throw new AttachmentReadError(checked.problem);
  return checked.kind === 'image' ? readImage(file, checked.mediaType) : readVideo(file, checked.mediaType);
}
