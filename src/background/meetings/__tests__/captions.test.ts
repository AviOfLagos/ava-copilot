import { describe, expect, it } from 'vitest';
import { CALL_DOM, captionDelta, watchCaptions } from '../captions';

const body = (source: string, start: number) => {
  // The function body from the brace at `start`, matched to its closing brace
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1).replace(/\s+/g, ' ');
  }
  throw new Error('No body');
};

describe('captionDelta', () => {
  it('sends a whole caption the first time, and nothing when it did not change', () => {
    expect(captionDelta('', 'Hello there')).toBe('Hello there');
    expect(captionDelta('Hello there', 'Hello there')).toBe('');
  });

  it('sends only the words a growing caption added', () => {
    expect(captionDelta('We ship on', 'We ship on Friday at noon')).toBe('Friday at noon');
  });

  it("continues after the last words sent when Meet drops a caption's oldest words", () => {
    expect(captionDelta('so the plan is to ship on Friday', 'plan is to ship on Friday after the review')).toBe(
      'after the review',
    );
  });

  it('sends a caption that was replaced by new words whole', () => {
    expect(captionDelta('Captions line 1', 'Captions line 2')).toBe('Captions line 2');
  });

  it('is the same code the page runs', () => {
    // watchCaptions runs in the page from its source text, so it carries its own copy
    const page = watchCaptions.toString();
    const inner = page.indexOf('const delta = (sent, text) =>');
    expect(inner).toBeGreaterThan(-1);
    const own = captionDelta.toString();
    expect(body(page, page.indexOf('{', inner))).toBe(body(own, own.indexOf('{')));
  });
});

describe('CALL_DOM', () => {
  const matches = (source: string, text: string) => new RegExp(source, 'i').test(text);

  it('knows the captions and leave buttons in the languages the extension ships', () => {
    for (const label of ['Turn on captions (c)', 'Ativar legendas (c)', '開啟字幕 (c)', '开启字幕']) {
      expect(matches(CALL_DOM.turnOnNames, label)).toBe(true);
    }
    for (const label of ['Turn off captions (c)', 'Desativar legendas (c)', '關閉字幕 (c)']) {
      expect(matches(CALL_DOM.turnOffNames, label)).toBe(true);
    }
    for (const label of ['Leave call', 'Sair da chamada', '退出通話', '離開通話']) {
      expect(matches(CALL_DOM.leaveNames, label)).toBe(true);
    }
  });

  it('does not take the captions buttons for each other', () => {
    expect(matches(CALL_DOM.turnOnNames, 'Turn off captions (c)')).toBe(false);
    expect(matches(CALL_DOM.turnOffNames, 'Turn on captions (c)')).toBe(false);
  });

  it('names the captions region exactly, never a button that mentions captions', () => {
    expect(matches(CALL_DOM.regionNames, 'Captions')).toBe(true);
    expect(matches(CALL_DOM.regionNames, 'Legendas')).toBe(true);
    expect(matches(CALL_DOM.regionNames, '字幕')).toBe(true);
    expect(matches(CALL_DOM.regionNames, 'Turn on captions')).toBe(false);
  });

  it("knows Meet's screen after leaving", () => {
    expect(matches(CALL_DOM.leftNames, 'Rejoin')).toBe(true);
    expect(matches(CALL_DOM.leftNames, 'Return to home screen')).toBe(true);
    expect(matches(CALL_DOM.leftNames, 'Leave call')).toBe(false);
  });
});
