import { describe, expect, it } from 'vitest';
import {
  countOneMore,
  nextWait,
  normalizePhone,
  prepareBatch,
  randomSeconds,
  remainingToday,
  renderTemplate,
  templateKeys,
} from '../bulk';
import { columnKey, parseCsv, parseCsvRecords, toCsv } from '../csv';
import { clampBulkSettings } from '../store';
import { BULK_HARD_DAILY_CAP, DEFAULT_BULK_SETTINGS } from '../types';

describe('WhatsApp bulk CSV', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const records = parseCsvRecords('name,note\n"Ada, PhD","She said ""hi""\nthen left"\n');
    expect(records).toEqual([
      ['name', 'note'],
      ['Ada, PhD', 'She said "hi"\nthen left'],
    ]);
  });

  it('drops a byte-order mark and handles CRLF', () => {
    const table = parseCsv('\uFEFFPhone,First Name\r\n+234 801 234 5678,Tomi\r\n\r\n');
    expect(table.headers).toEqual(['phone', 'first_name']);
    expect(table.rows).toEqual([{ phone: '+234 801 234 5678', first_name: 'Tomi' }]);
  });

  it('detects a semicolon or tab separator', () => {
    expect(parseCsv('phone;name\n4915112345678;Lena').rows).toEqual([{ phone: '4915112345678', name: 'Lena' }]);
    expect(parseCsv('phone\tname\n4915112345678\tLena').rows).toEqual([{ phone: '4915112345678', name: 'Lena' }]);
  });

  it('keeps a comma inside quotes when the separator is a semicolon', () => {
    expect(parseCsv('phone;name\n4915112345678;"Lena; Max, Jr"').rows[0].name).toBe('Lena; Max, Jr');
  });

  it('fills missing trailing fields with empty strings', () => {
    expect(parseCsv('phone,name,city\n4915112345678,Lena').rows[0]).toEqual({
      phone: '4915112345678',
      name: 'Lena',
      city: '',
    });
  });

  it('writes fields back with quotes only where needed', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x, y', 'plain'],
          ['say "hi"', ''],
        ],
      ),
    ).toBe('a,b\r\n"x, y",plain\r\n"say ""hi""",');
  });

  it('turns headers into template keys', () => {
    expect(columnKey('  First Name ')).toBe('first_name');
    expect(columnKey('Order-ID')).toBe('order_id');
  });
});

describe('WhatsApp bulk template', () => {
  it('fills {{name}} and any column, case and spacing aside', () => {
    const out = renderTemplate('Hi {{ Name }}, your order {{order_id}} ships {{ Day }}.', {
      name: 'Tomi',
      order_id: 'A12',
      day: 'Friday',
    });
    expect(out).toEqual({ text: 'Hi Tomi, your order A12 ships Friday.', missing: [] });
  });

  it('renders an unknown or empty placeholder as nothing and reports it', () => {
    const out = renderTemplate('Hi {{name}}, see you {{when}}!', { name: '' });
    expect(out.text).toBe('Hi, see you!');
    expect(out.missing.sort()).toEqual(['name', 'when']);
  });

  it('keeps line breaks', () => {
    expect(renderTemplate('Hi {{name}}\nBye', { name: 'Ada' }).text).toBe('Hi Ada\nBye');
  });

  it('lists the keys a template uses', () => {
    expect(templateKeys('{{Name}} {{name}} {{City Name}}')).toEqual(['name', 'city_name']);
  });
});

describe('WhatsApp bulk recipients', () => {
  it('normalises phone numbers to digits with the country code', () => {
    expect(normalizePhone('+234 (801) 234-5678')).toBe('2348012345678');
    expect(normalizePhone('0044 20 7946 0958')).toBe('442079460958');
    expect(normalizePhone('4915112345678')).toBe('4915112345678');
  });

  it('refuses numbers that cannot be international', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('0801 234 5678')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone('1234567890123456')).toBeNull();
  });

  it('dedupes, respects the opt-out column and skips invalid numbers, keeping order', () => {
    const table = parseCsv(
      [
        'phone,name,opt_out',
        '+2348012345678,Tomi,',
        '2348012345678,Tomi again,',
        '4915112345678,Lena,yes',
        'not a number,Bad,',
        '447700900123,Sam,no',
      ].join('\n'),
    );
    const batch = prepareBatch(table, 'Hi {{name}}');
    expect(batch.recipients.map(r => [r.status, r.reason, r.message])).toEqual([
      ['pending', '', 'Hi Tomi'],
      ['skipped', 'duplicate', ''],
      ['skipped', 'opted_out', ''],
      ['skipped', 'invalid_number', ''],
      ['pending', '', 'Hi Sam'],
    ]);
    expect(batch.columns).toEqual({ phone: 'phone', name: 'name', optOut: 'opt_out' });
  });

  it('skips a row whose message renders empty', () => {
    const batch = prepareBatch(parseCsv('phone,name\n4915112345678,'), '{{name}}');
    expect(batch.recipients[0]).toMatchObject({ status: 'skipped', reason: 'empty_message' });
  });

  it('reports placeholders no column provides', () => {
    const batch = prepareBatch(parseCsv('mobile,name\n4915112345678,Lena'), 'Hi {{name}} from {{city}}');
    expect(batch.unknownPlaceholders).toEqual(['city']);
    expect(batch.columns.phone).toBe('mobile');
  });

  it('needs a phone column', () => {
    expect(() => prepareBatch(parseCsv('name\nLena'), 'Hi')).toThrow(/phone column/);
  });
});

describe('WhatsApp bulk pacing', () => {
  const settings = { ...DEFAULT_BULK_SETTINGS };

  it('picks whole seconds within the bounds, both ends included', () => {
    expect(randomSeconds(8, 20, () => 0)).toBe(8);
    expect(randomSeconds(8, 20, () => 0.9999)).toBe(20);
    expect(randomSeconds(20, 8, () => 0.5)).toBe(14);
  });

  it('waits the ordinary gap between messages and a cooldown every N', () => {
    // A fake random source walks through the range so each wait is known
    const random = () => 0;
    const waits = [];
    let since = 0;
    for (let sent = 1; sent <= 21; sent++) {
      since += 1;
      const wait = nextWait(settings, since, random);
      if (wait.cooldown) since = 0;
      waits.push(wait);
    }
    const cooldowns = waits.map((wait, index) => (wait.cooldown ? index + 1 : 0)).filter(Boolean);
    expect(cooldowns).toEqual([10, 20]);
    expect(waits[0]).toEqual({ ms: 8000, cooldown: false });
    expect(waits[9]).toEqual({ ms: 120_000, cooldown: true });
  });

  it('keeps the daily cap per local day', () => {
    expect(remainingToday({ day: '2026-10-14', sent: 48 }, '2026-10-14', 50)).toBe(2);
    expect(remainingToday({ day: '2026-10-14', sent: 50 }, '2026-10-14', 50)).toBe(0);
    expect(remainingToday({ day: '2026-10-13', sent: 50 }, '2026-10-14', 50)).toBe(50);
    expect(countOneMore({ day: '2026-10-13', sent: 50 }, '2026-10-14')).toEqual({ day: '2026-10-14', sent: 1 });
    expect(countOneMore({ day: '2026-10-14', sent: 3 }, '2026-10-14')).toEqual({ day: '2026-10-14', sent: 4 });
  });

  it('clamps settings to the safety limits', () => {
    expect(clampBulkSettings({ dailyCap: 1000 }).dailyCap).toBe(BULK_HARD_DAILY_CAP);
    expect(clampBulkSettings({ dailyCap: 0 }).dailyCap).toBe(1);
    expect(clampBulkSettings({ delayMinSec: 0, delayMaxSec: -5 })).toMatchObject({ delayMinSec: 1, delayMaxSec: 1 });
    expect(clampBulkSettings({ cooldownMinSec: 300, cooldownMaxSec: 60 })).toMatchObject({
      cooldownMinSec: 300,
      cooldownMaxSec: 300,
    });
    expect(clampBulkSettings({ dailyCap: Number.NaN }).dailyCap).toBe(50);
    expect(clampBulkSettings({})).toEqual(DEFAULT_BULK_SETTINGS);
  });
});
