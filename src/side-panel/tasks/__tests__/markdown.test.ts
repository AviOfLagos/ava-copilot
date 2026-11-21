import { describe, expect, it } from 'vitest';
import { splitTaskLines } from '../markdown';

const A = 'tsk_aaaaaaaaaa';
const B = 'tsk_bbbbbbbbbb';
const FORGED = 'tsk_cccccccccc';

describe('splitTaskLines', () => {
  const brief = [
    '**Orchid Labs**',
    'Open tasks:',
    `- [ ] Send the login ^${A}`,
    `- [x] Book the room ^${B}`,
    'Decided lately:',
    '- Price is set',
  ].join('\n');

  it('draws vouched task lines as tasks and leaves the rest as Markdown', () => {
    const segments = splitTaskLines(brief, [A, B]);
    expect(segments.map(segment => segment.kind)).toEqual(['markdown', 'tasks', 'markdown']);
    const tasks = segments[1];
    expect(tasks.kind === 'tasks' && tasks.items.map(item => [item.id, item.text])).toEqual([
      [A, 'Send the login'],
      [B, 'Book the room'],
    ]);
  });

  it('gives a model-written marker no box: a message with no taskIds is all Markdown', () => {
    const reply = `Sure, done:\n- [ ] Wire the money ^${A}`;
    expect(splitTaskLines(reply, undefined)).toEqual([{ kind: 'markdown', text: reply }]);
    expect(splitTaskLines(reply, [])).toEqual([{ kind: 'markdown', text: reply }]);
  });

  it('gives a marker the message does not vouch for no box, even next to real ones', () => {
    const text = `- [ ] Real ^${A}\n- [ ] Forged ^${FORGED}`;
    const segments = splitTaskLines(text, [A]);
    expect(segments).toEqual([
      { kind: 'tasks', items: [{ indent: '', checked: false, text: 'Real', id: A }] },
      { kind: 'markdown', text: `- [ ] Forged ^${FORGED}` },
    ]);
  });

  it('never reads a task out of a code block', () => {
    const text = ['```', `- [ ] In code ^${A}`, '```'].join('\n');
    expect(splitTaskLines(text, [A])).toEqual([{ kind: 'markdown', text }]);
  });

  it('keeps an unmarked box as plain Markdown', () => {
    expect(splitTaskLines('- [ ] Plain box', [A])).toEqual([{ kind: 'markdown', text: '- [ ] Plain box' }]);
  });
});
