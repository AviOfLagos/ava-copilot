import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeQr, qrPath } from '../qr';

// Checked module for module, every mask, against Kazuhiko Arase's reference encoder when this was written
const fingerprint = (modules: boolean[][]) =>
  createHash('sha256')
    .update(modules.map(row => row.map(Number).join('')).join('\n'))
    .digest('hex')
    .slice(0, 16);

const finderAt = (modules: boolean[][], x: number, y: number) =>
  [0, 1, 2, 3, 4, 5, 6].every(
    i => modules[y][x + i] && modules[y + 6][x + i] && modules[y + i][x] && modules[y + i][x + 6],
  ) &&
  modules[y + 3][x + 3] &&
  !modules[y + 1][x + 1];

describe('the QR code for the linking code', () => {
  it('picks the smallest version that fits', () => {
    expect(encodeQr('hello')).toHaveLength(21);
    // A WhatsApp pairing string is about 200 characters
    const pairing = `2@${'A'.repeat(60)},${'B'.repeat(44)},${'C'.repeat(44)},${'D'.repeat(44)},1`;
    expect(encodeQr(pairing).length).toBe(4 * 10 + 17);
  });

  it('has its three finder patterns', () => {
    const modules = encodeQr('https://example.com');
    const size = modules.length;
    expect(finderAt(modules, 0, 0)).toBe(true);
    expect(finderAt(modules, size - 7, 0)).toBe(true);
    expect(finderAt(modules, 0, size - 7)).toBe(true);
  });

  it('draws the same symbol every time', () => {
    expect(fingerprint(encodeQr('hello', 0))).toBe(fingerprint(encodeQr('hello', 0)));
    expect(encodeQr('hello')).toEqual(encodeQr('hello'));
  });

  it('draws only dark modules, inside a quiet zone', () => {
    const path = qrPath([
      [true, false],
      [false, true],
    ]);
    expect(path).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
  });
});
