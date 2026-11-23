import { describe, expect, it, vi } from 'vitest';
import { HEARING_NOTICE, HearingWatch, SILENT_MS, UNCLEAR_TURNS, unclearText } from '../hearing';
import { inputTranscription, refusedLanguageHint, voiceSetup } from '../voice';

describe('unclearText', () => {
  it('takes empty, bracketed noise, lone letters and symbol soup as unclear', () => {
    for (const text of ['', '   ', '[BLANK_AUDIO]', '(music)', '...', 'a', '♪ ♪ ♪', '?? !! ..']) {
      expect(unclearText(text), text).toBe(true);
    }
  });

  it('takes real words as clear, in any script', () => {
    for (const text of ['what is on my calendar', 'ok', 'olá, tudo bem', '今天的會議', '好', '是', '42']) {
      expect(unclearText(text), text).toBe(false);
    }
  });
});

describe('HearingWatch', () => {
  it('warns once when the mic stays silent while listening', () => {
    const onTrouble = vi.fn();
    const watch = new HearingWatch(onTrouble);
    for (let t = 0; t <= SILENT_MS; t += 500) watch.level(0, t);
    expect(onTrouble).toHaveBeenCalledTimes(1);
    expect(onTrouble).toHaveBeenCalledWith('mic-silent');
    for (let t = SILENT_MS; t <= SILENT_MS * 3; t += 500) watch.level(0, t);
    watch.recognised('');
    watch.recognised('');
    watch.recognised('');
    expect(onTrouble).toHaveBeenCalledTimes(1);
  });

  it('never warns about silence once the mic has heard anything: quiet is then the user thinking', () => {
    const onTrouble = vi.fn();
    const watch = new HearingWatch(onTrouble);
    watch.level(0.02, 0);
    for (let t = 500; t < SILENT_MS * 4; t += 500) watch.level(0, t);
    expect(onTrouble).not.toHaveBeenCalled();
  });

  it('does not count time while answering, nor across a gap in readings', () => {
    const onTrouble = vi.fn();
    const watch = new HearingWatch(onTrouble);
    for (let t = 0; t < SILENT_MS - 1000; t += 500) watch.level(0, t);
    // Ava speaking: not listening
    for (let t = SILENT_MS - 1000; t < SILENT_MS * 2; t += 500) watch.level(0, t, false);
    // The mic was held for a minute: the first reading after it starts a new stretch
    watch.level(0, SILENT_MS * 5);
    watch.level(0, SILENT_MS * 5 + 500);
    expect(onTrouble).not.toHaveBeenCalled();
  });

  it('warns after several empty or garbled turns in a row, and clear words reset the count', () => {
    const onTrouble = vi.fn();
    const watch = new HearingWatch(onTrouble);
    for (let i = 0; i < UNCLEAR_TURNS - 1; i++) watch.recognised('[BLANK_AUDIO]');
    watch.recognised('what time is it');
    for (let i = 0; i < UNCLEAR_TURNS - 1; i++) watch.recognised('');
    expect(onTrouble).not.toHaveBeenCalled();
    watch.recognised('...');
    expect(onTrouble).toHaveBeenCalledWith('unclear-turns');
    expect(watch.hasWarned).toBe(true);
  });

  it('says it may not be hearing well and offers check_audio', () => {
    expect(HEARING_NOTICE).toMatch(/may not be hearing you well/);
    expect(HEARING_NOTICE).toMatch(/check your mic/);
    expect(HEARING_NOTICE).toMatch(/check_audio/);
  });
});

describe('the Live transcript language', () => {
  const options = { model: 'gemini-live', instructions: '', tools: [], language: 'pt-BR' } as never;

  it("hints the user's language to the transcript of what they say", () => {
    expect(inputTranscription('pt-BR')).toEqual({ languageCodes: ['pt-BR'] });
    expect(inputTranscription()).toEqual({});
    expect(voiceSetup(options, null).setup.inputAudioTranscription).toEqual({ languageCodes: ['pt-BR'] });
    // The answer's transcript is left alone
    expect(voiceSetup(options, null).setup.outputAudioTranscription).toEqual({});
  });

  it('goes without the hint once the service refuses it', () => {
    expect(voiceSetup(options, null, false).setup.inputAudioTranscription).toEqual({});
    expect(refusedLanguageHint(1007, 'Invalid value at setup.input_audio_transcription.language_codes')).toBe(true);
    expect(refusedLanguageHint(1007, 'API key not valid')).toBe(false);
    // The speech language is a different setting: not this hint
    expect(refusedLanguageHint(1007, 'Unsupported speech_config.language_code')).toBe(false);
    expect(refusedLanguageHint(1000, 'language')).toBe(false);
  });
});
