/**
 * Pictures and short videos attached to a chat message: what is accepted, and how a video is sampled into
 * frames. Shared by the panel (which reads the files) and the background (which checks what arrives).
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 60;
// At most this many pictures and videos on one message
export const MAX_ATTACHMENTS = 6;
// A video is shown to the model as one frame every this many seconds, at most MAX_FRAMES of them
export const FRAME_EVERY_SECONDS = 2;
export const MAX_FRAMES = 16;
// What arrives from the panel, base64: a frame or thumbnail is a small JPEG, a video's audio 16 kHz mono WAV
export const MAX_FRAME_BASE64 = 1_500_000;
export const MAX_AUDIO_BASE64 = 3_000_000;

export type AttachmentKind = 'image' | 'video';

const BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** The media type of a picked file: its own when it is one we take, else read from its name. */
export function mediaTypeOf(name: string, type: string): string | null {
  const lower = type.toLowerCase();
  if ((IMAGE_TYPES as readonly string[]).includes(lower) || (VIDEO_TYPES as readonly string[]).includes(lower)) {
    return lower;
  }
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? (BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null) : null;
}

export function kindOf(mediaType: string): AttachmentKind | null {
  if ((IMAGE_TYPES as readonly string[]).includes(mediaType)) return 'image';
  if ((VIDEO_TYPES as readonly string[]).includes(mediaType)) return 'video';
  return null;
}

export type AttachmentProblem = 'type' | 'imageTooBig' | 'videoTooBig' | 'videoTooLong' | 'tooMany';

/**
 * Whether a file can be attached. `durationSec` is checked only for a video, once it is known.
 *
 * @returns the kind and media type, or the problem with it
 */
export function checkAttachment(
  file: { name: string; type: string; size: number; durationSec?: number },
  alreadyAttached = 0,
): { ok: true; kind: AttachmentKind; mediaType: string } | { ok: false; problem: AttachmentProblem } {
  if (alreadyAttached >= MAX_ATTACHMENTS) return { ok: false, problem: 'tooMany' };
  const mediaType = mediaTypeOf(file.name, file.type);
  const kind = mediaType ? kindOf(mediaType) : null;
  if (!mediaType || !kind) return { ok: false, problem: 'type' };
  if (kind === 'image' && file.size > MAX_IMAGE_BYTES) return { ok: false, problem: 'imageTooBig' };
  if (kind === 'video') {
    if (file.size > MAX_VIDEO_BYTES) return { ok: false, problem: 'videoTooBig' };
    // A tiny tolerance: a 60 s clip often reports 60.02 s
    if (file.durationSec !== undefined && file.durationSec > MAX_VIDEO_SECONDS + 0.5) {
      return { ok: false, problem: 'videoTooLong' };
    }
  }
  return { ok: true, kind, mediaType };
}

/**
 * The moments of a video to show the model: one every `every` seconds from the middle of the first interval,
 * spread evenly across the whole clip when that would be more than `max`. A clip too short to have an
 * interval gives its middle frame.
 */
export function framePlan(durationSec: number, every = FRAME_EVERY_SECONDS, max = MAX_FRAMES): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const count = Math.max(1, Math.min(max, Math.floor(durationSec / every)));
  const step = durationSec / count;
  const round = (value: number) => Math.round(value * 100) / 100;
  return Array.from({ length: count }, (_, index) => round(step * index + step / 2));
}

/** The size of base64 text once decoded, in bytes. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** An attachment as the panel sends it to the background: base64, never a URL (checked again there). */
export interface OutgoingAttachment {
  kind: AttachmentKind;
  name: string;
  // The type of `data` for an image (it is sent as the model will see it), of the file for a video
  mediaType: string;
  size: number;
  data?: string;
  // A small JPEG
  thumb: string;
  frames?: { t: number; data: string }[];
  durationSec?: number;
  // A video's sound as 16 kHz mono WAV, when a speech model is set to write it down
  audio?: string;
}
