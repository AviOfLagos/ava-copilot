import { describe, expect, it } from 'vitest';
import { parseTaskLine, stripTaskMarkers, taskLine, taskMarker } from '../markers';
import { newTaskId } from '../types';

describe('task markers', () => {
  it('writes a task line with its marker at the end', () => {
    expect(taskLine({ id: 'tsk_abcdefghij', status: 'open' }, 'Send the login')).toBe(
      '- [ ] Send the login ^tsk_abcdefghij',
    );
    expect(taskLine({ id: 'tsk_abcdefghij', status: 'done' }, 'Send the login')).toBe(
      '- [x] Send the login ^tsk_abcdefghij',
    );
    expect(taskMarker('tsk_abcdefghij')).toBe(' ^tsk_abcdefghij');
  });

  it('reads a marked line back, and nothing else', () => {
    expect(parseTaskLine('- [ ] Send the login ^tsk_abcdefghij')).toEqual({
      indent: '',
      checked: false,
      text: 'Send the login',
      id: 'tsk_abcdefghij',
    });
    expect(parseTaskLine('  * [x] Done thing ^tsk_abcdefghij ')?.checked).toBe(true);
    // No box, a marker in the middle, a bad id, or a plain box
    expect(parseTaskLine('- Send the login ^tsk_abcdefghij')).toBeNull();
    expect(parseTaskLine('- [ ] Send ^tsk_abcdefghij the login')).toBeNull();
    expect(parseTaskLine('- [ ] Send the login ^tsk_ABCDEFGHIJ')).toBeNull();
    expect(parseTaskLine('- [ ] Send the login ^tsk_abc')).toBeNull();
    expect(parseTaskLine('- [ ] Send the login')).toBeNull();
  });

  it('is stripped from text for WhatsApp, voice and exports, leaving the words', () => {
    const text = '**Orchid**\nOpen tasks:\n- [ ] Send the login (Ada) ^tsk_abcdefghij\n- [x] Book ^tsk_bcdefghijk';
    expect(stripTaskMarkers(text)).toBe('**Orchid**\nOpen tasks:\n- [ ] Send the login (Ada)\n- [x] Book');
    // A longer word that only starts like a marker is left alone
    expect(stripTaskMarkers('see ^tsk_abcdefghijk2')).toBe('see ^tsk_abcdefghijk2');
  });

  it('makes ids of the right shape', () => {
    const ids = new Set(Array.from({ length: 50 }, newTaskId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^tsk_[a-z2-7]{10}$/);
  });
});
