import { describe, expect, it } from 'vitest';
import {
  addFact,
  applyReflectedGoals,
  cleanCore,
  DEFAULT_CORE,
  effectiveCore,
  EMPTY_ABOUT_YOU,
  findFact,
  normalizeAboutYou,
  saveGoal,
  updateFact,
} from '../memory';
import { FACTS_MAX, GOALS_PER_WORKSPACE_MAX } from '../types';
import { acceptsLanguageCode, listeningHint, liveSpeechConfig, liveVoiceOf, voiceLanguageOf } from '../voice';

const input = (text: string, extra = {}) => ({
  text,
  source: 'said' as const,
  status: 'active' as const,
  via: 'chat',
  ...extra,
});

describe('facts', () => {
  it('adds, dedupes by words and workspace, and activates a proposed copy the user then says', () => {
    const first = addFact(EMPTY_ABOUT_YOU, input('Runs Nexprove', { status: 'proposed' }), 1);
    expect(first.ok && first.fact.status).toBe('proposed');
    const again = addFact(first.ok ? first.state : EMPTY_ABOUT_YOU, input('runs nexprove!'), 2);
    expect(again.ok && again.state.facts).toHaveLength(1);
    expect(again.ok && again.fact.status).toBe('active');
    const other = addFact(again.ok ? again.state : EMPTY_ABOUT_YOU, input('Runs Nexprove', { workspaceId: 'ws' }), 3);
    expect(other.ok && other.state.facts).toHaveLength(2);
  });

  it('refuses an empty fact and keeps at most FACTS_MAX, dropping proposed ones first', () => {
    expect(addFact(EMPTY_ABOUT_YOU, input('   ')).ok).toBe(false);
    let state = EMPTY_ABOUT_YOU;
    const proposed = addFact(state, input('A proposed one', { status: 'proposed' }), 0);
    state = proposed.ok ? proposed.state : state;
    for (let i = 0; i < FACTS_MAX; i++) {
      const next = addFact(state, input(`Fact ${i}`), i + 1);
      state = next.ok ? next.state : state;
    }
    expect(state.facts).toHaveLength(FACTS_MAX);
    expect(state.facts.some(fact => fact.text === 'A proposed one')).toBe(false);
  });

  it('keeps what a fact said before, and until when (temporal)', () => {
    const added = addFact(EMPTY_ABOUT_YOU, input('Works at Acme'), 1);
    if (!added.ok) throw new Error('not added');
    const moved = updateFact(added.state, added.fact.id, { text: 'Works at Ellum' }, 50);
    expect(moved.ok && moved.fact.previous).toEqual([{ text: 'Works at Acme', until: 50 }]);
    expect(moved.ok && moved.fact.text).toBe('Works at Ellum');
  });

  it('finds a fact by some of its words', () => {
    const added = addFact(EMPTY_ABOUT_YOU, input('Works at Acme as designer'), 1);
    const state = added.ok ? added.state : EMPTY_ABOUT_YOU;
    expect(findFact(state, 'acme designer')?.text).toBe('Works at Acme as designer');
    expect(findFact(state, 'lives in Paris')).toBeUndefined();
  });

  it('normalizes a broken stored state', () => {
    const state = normalizeAboutYou({ facts: [{ id: 'x', text: 'a', category: 'weird' } as never] });
    expect(state.facts[0].category).toBe('other');
    expect(state.goals).toEqual([]);
    expect(state.lastReflectionAt).toBeNull();
  });
});

describe('goals', () => {
  it('replaces earlier reflected goals, keeps the user’s own, and caps a workspace', () => {
    const own = saveGoal(EMPTY_ABOUT_YOU, { text: 'Ship the website', workspaceId: 'ws' }, 1);
    let state = own.ok ? own.state : EMPTY_ABOUT_YOU;
    state = applyReflectedGoals(state, 'ws', ['Old goal'], 2);
    state = applyReflectedGoals(state, 'ws', ['Close the deal', 'ship the website', 'Hire a designer', 'Fourth'], 3);
    const ws = state.goals.filter(goal => goal.workspaceId === 'ws');
    expect(ws.map(goal => goal.text)).toEqual(['Ship the website', 'Close the deal', 'Hire a designer']);
    expect(ws).toHaveLength(GOALS_PER_WORKSPACE_MAX);
    expect(ws[0].source).toBe('user');
  });
});

describe('core identity', () => {
  it('falls back to the defaults and stores defaults as empty', () => {
    expect(effectiveCore(null)).toEqual(DEFAULT_CORE);
    const core = cleanCore({ character: 'Dry and precise.', values: DEFAULT_CORE.values, purpose: '' }, 5);
    expect(core).toEqual({ character: 'Dry and precise.', values: '', purpose: '', updatedAt: 5 });
    expect(effectiveCore(core).values).toBe(DEFAULT_CORE.values);
  });
});

describe('voice and language', () => {
  it('always sends the voice, and the language only to models that take it', () => {
    expect(liveSpeechConfig('gemini-3.8-live', { liveVoice: 'kore', language: 'pt-BR' })).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
    expect(liveSpeechConfig('gemini-live-2.5-flash-preview', { liveVoice: 'Aoede', language: 'pt-BR' })).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
      languageCode: 'pt-BR',
    });
    expect(acceptsLanguageCode('gemini-2.5-flash-native-audio-preview-09-2025')).toBe(false);
    expect(acceptsLanguageCode('gemini-2.0-flash-live-001')).toBe(true);
  });

  it('cleans stored values', () => {
    expect(liveVoiceOf('nobody')).toBe('Aoede');
    expect(voiceLanguageOf('english please')).toBe('en-US');
    expect(voiceLanguageOf('cmn-CN')).toBe('cmn-CN');
  });
});

describe('listeningHint', () => {
  it('tells every speech model the user speaks the language whatever their accent', () => {
    expect(listeningHint('en-US')).toMatch(/speaks English \(US\), whatever their accent/);
    expect(listeningHint('en-US')).not.toMatch(/Nigerian/);
  });

  it('knows Nigerian English', () => {
    expect(voiceLanguageOf('en-NG')).toBe('en-NG');
    expect(listeningHint('en-NG')).toMatch(/Nigerian accent.*Pidgin.*understand them as English/);
  });
});
