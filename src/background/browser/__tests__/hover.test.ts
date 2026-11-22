import { describe, expect, it } from 'vitest';
import { formatHoverHints, matchHoverHosts, type HiddenControl } from '../hover';

const control = (label: string, ...ancestors: string[]): HiddenControl => ({ label, xpath: `${label}-own`, ancestors });

describe('matchHoverHosts', () => {
  it('names the nearest ancestor that has an index', () => {
    const indexByXpath = new Map([
      ['html/body/div/ul/li[2]', 7],
      ['html/body/div/ul', 3],
    ]);
    const hints = matchHoverHosts(
      [control('Save', 'html/body/div/ul/li[2]/div', 'html/body/div/ul/li[2]')],
      indexByXpath,
    );
    expect(hints).toEqual([{ index: 7, labels: ['Save'] }]);
  });

  it('falls back to an indexed element inside a close ancestor (a pin link beside its Save button)', () => {
    const indexByXpath = new Map([
      ['html/body/div/div[1]/a', 5],
      ['html/body/div/div[2]/a', 6],
    ]);
    const hints = matchHoverHosts(
      [
        control('Save', 'html/body/div/div[2]', 'html/body/div'),
        control('Save', 'html/body/div/div[1]', 'html/body/div'),
      ],
      indexByXpath,
    );
    expect(hints).toEqual([
      { index: 5, labels: ['Save'] },
      { index: 6, labels: ['Save'] },
    ]);
  });

  it('groups labels under one host once, and skips controls with no element to hover', () => {
    const indexByXpath = new Map([['html/body/a', 2]]);
    const hints = matchHoverHosts(
      [
        control('Save', 'html/body/a'),
        control('Save', 'html/body/a'),
        control('Share', 'html/body/a'),
        control('Lost', 'html/body/nav/x', 'html/body/nav/y', 'html/body/nav/z'),
      ],
      indexByXpath,
    );
    expect(hints).toEqual([{ index: 2, labels: ['Save', 'Share'] }]);
  });

  it('skips a control that already has an index', () => {
    const indexByXpath = new Map([
      ['html/body/a', 2],
      ['Save-own', 3],
    ]);
    expect(matchHoverHosts([control('Save', 'html/body/a')], indexByXpath)).toEqual([]);
  });

  it('keeps the list short', () => {
    const indexByXpath = new Map<string, number>();
    const controls: HiddenControl[] = [];
    for (let i = 1; i <= 20; i++) {
      indexByXpath.set(`html/body/a[${i}]`, i);
      controls.push(control('Save', `html/body/a[${i}]`));
    }
    expect(matchHoverHosts(controls, indexByXpath)).toHaveLength(8);
  });
});

describe('formatHoverHints', () => {
  it('is empty when nothing is hidden', () => {
    expect(formatHoverHints([])).toBe('');
  });

  it('writes one line per host', () => {
    const text = formatHoverHints([
      { index: 5, labels: ['Save'] },
      { index: 6, labels: ['Save', 'Share'] },
    ]);
    expect(text).toContain('[5] reveals: Save');
    expect(text).toContain('[6] reveals: Save, Share');
    expect(text.split('\n')).toHaveLength(3);
  });
});
