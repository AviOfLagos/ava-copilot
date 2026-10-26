/**
 * A small Ogg muxer for one Opus stream (RFC 7845): what WhatsApp plays as a voice note. WebCodecs gives the Opus
 * packets; this wraps them in pages with the two header packets in front. Granule positions count 48 kHz samples
 * whatever the input rate, and the last page's position trims the padding the encoder added at the end.
 */

export interface OpusPacket {
  data: Uint8Array;
  // Its length in 48 kHz samples (960 for 20 ms)
  samples: number;
}

export interface OggOpusStream {
  packets: OpusPacket[];
  // The rate the audio was recorded at (kept in the header for information; decoders play at 48 kHz)
  inputSampleRate: number;
  channels: number;
  // Samples the decoder drops at the start: the encoder's look-ahead, in 48 kHz samples
  preSkip: number;
  // The audio's real length in 48 kHz samples, without pre-skip or padding
  length: number;
  // The stream's serial number; any 32-bit value
  serial?: number;
}

// Packets per page: about a second of 20 ms frames, well under the 255 segments a page can hold
const PACKETS_PER_PAGE = 50;
const HEADER_TYPE = { first: 2, last: 4 } as const;

let crcTable: Uint32Array | null = null;

/** Ogg's CRC-32: polynomial 0x04c11db7, not reflected, starting at 0, no final xor. */
export function oggCrc(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

/** One page holding whole packets. */
export function oggPage(
  packets: Uint8Array[],
  options: { granule: number; serial: number; sequence: number; type: number },
): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  if (lacing.length > 255) throw new Error('Too many packets for one Ogg page.');
  const bodyLength = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[4] = 0; // version
  page[5] = options.type;
  view.setBigInt64(6, BigInt(options.granule), true);
  view.setUint32(14, options.serial >>> 0, true);
  view.setUint32(18, options.sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** The identification header: version 1, channels, pre-skip, input rate, no gain, mono/stereo mapping. */
export function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode('OpusHead'));
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}

/** The comment header: who made it, no tags. */
export function opusTags(vendor = 'Ava Copilot'): Uint8Array {
  const name = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(8 + 4 + name.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode('OpusTags'));
  view.setUint32(8, name.length, true);
  tags.set(name, 12);
  view.setUint32(12 + name.length, 0, true);
  return tags;
}

/** The whole file: header pages, then the audio a second per page, the last page marked and trimmed. */
export function oggOpus(stream: OggOpusStream): Uint8Array {
  if (!stream.packets.length) throw new Error('There is no audio to wrap.');
  const serial = stream.serial ?? 0x41766121;
  const pages: Uint8Array[] = [
    oggPage([opusHead(stream.channels, stream.preSkip, stream.inputSampleRate)], {
      granule: 0,
      serial,
      sequence: 0,
      type: HEADER_TYPE.first,
    }),
    oggPage([opusTags()], { granule: 0, serial, sequence: 1, type: 0 }),
  ];
  const end = stream.preSkip + stream.length;
  let granule = 0;
  let previous = 0;
  for (let start = 0; start < stream.packets.length; start += PACKETS_PER_PAGE) {
    const group = stream.packets.slice(start, start + PACKETS_PER_PAGE);
    granule += group.reduce((sum, packet) => sum + packet.samples, 0);
    const last = start + PACKETS_PER_PAGE >= stream.packets.length;
    // The end trims the encoder's padding, but a position never goes back
    const position = last ? Math.max(previous, Math.min(granule, end)) : granule;
    pages.push(
      oggPage(
        group.map(packet => packet.data),
        { granule: position, serial, sequence: pages.length, type: last ? HEADER_TYPE.last : 0 },
      ),
    );
    previous = position;
  }
  const file = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));
  let offset = 0;
  for (const page of pages) {
    file.set(page, offset);
    offset += page.length;
  }
  return file;
}
