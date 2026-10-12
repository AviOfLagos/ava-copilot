const HEADER_LENGTH = 44;
const BITS_PER_SAMPLE = 16;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** A 44-byte canonical PCM WAV header for `dataLength` bytes of 16-bit audio. */
export function wavHeader(dataLength: number, sampleRateHz: number, channels = 1): Uint8Array {
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const byteRate = sampleRateHz * blockAlign;
  const buffer = new ArrayBuffer(HEADER_LENGTH);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM, no compression
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  return new Uint8Array(buffer);
}

/**
 * Wraps raw little-endian 16-bit PCM audio (as Gemini's TTS returns it) in a WAV header, as a data
 * URL an `<audio>` element can play with no network fetch. Gemini TTS is mono by default.
 */
export function pcmToWavDataUrl(base64Pcm: string, sampleRateHz: number, channels = 1): string {
  const pcm = base64ToBytes(base64Pcm);
  const header = wavHeader(pcm.length, sampleRateHz, channels);
  const bytes = new Uint8Array(header.length + pcm.length);
  bytes.set(header, 0);
  bytes.set(pcm, header.length);
  return `data:audio/wav;base64,${bytesToBase64(bytes)}`;
}
