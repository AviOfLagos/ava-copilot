import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseVersion } from '../semver';

describe('parseVersion', () => {
  it('reads a plain x.y.z version', () => {
    expect(parseVersion('1.4.0')).toEqual([1, 4, 0]);
    expect(parseVersion(' 0.2.0 ')).toEqual([0, 2, 0]);
  });

  it('refuses anything else', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('1.4')).toBeNull();
    expect(parseVersion('v1.4.0')).toBeNull();
    expect(parseVersion('not-a-version')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('compares major, then minor, then patch', () => {
    expect(isNewerVersion('1.4.0', '1.3.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.4.1', '1.4.0')).toBe(true);
    expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false);
    expect(isNewerVersion('1.3.9', '1.4.0')).toBe(false);
  });

  it('is never "newer" when either side cannot be parsed', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'not-a-version')).toBe(false);
  });
});
