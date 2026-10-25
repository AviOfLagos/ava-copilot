import { describe, expect, it } from 'vitest';
import { FORGET_THAT_MINUTES, matchAmbientSwitch, plainSpeech } from '../phrases';

describe('matchAmbientSwitch', () => {
  it('ignores ordinary talk, even when it uses the same words', () => {
    for (const said of [
      'I think we should just listen to the client first',
      'we talked off the record about the launch yesterday',
      'can you forget the last ten minutes of that movie',
      'feel free to chime in on the doc',
      'Ava is a nice name',
      '',
      'Hmm.',
    ]) {
      expect(matchAmbientSwitch(said), said).toBeNull();
    }
  });

  it('switches mode only when addressed by name', () => {
    expect(matchAmbientSwitch('Ava, just listen.')).toEqual({ kind: 'listen' });
    expect(matchAmbientSwitch('Hey Ava, just listen')).toEqual({ kind: 'listen' });
    expect(matchAmbientSwitch('Eva just listen')).toEqual({ kind: 'listen' });
    expect(matchAmbientSwitch('Ava, feel free to chime in!')).toEqual({ kind: 'companion' });
    expect(matchAmbientSwitch('Ava go quiet')).toEqual({ kind: 'quiet' });
    expect(matchAmbientSwitch('Ava, stop listening.')).toEqual({ kind: 'quiet' });
    expect(matchAmbientSwitch('just listen')).toBeNull();
  });

  it('goes off and back on the record with or without the name, as a whole utterance', () => {
    expect(matchAmbientSwitch('Ava, off the record.')).toEqual({ kind: 'off_record' });
    expect(matchAmbientSwitch("Let's go off the record")).toEqual({ kind: 'off_record' });
    expect(matchAmbientSwitch('This is off the record')).toEqual({ kind: 'off_record' });
    expect(matchAmbientSwitch('Back on the record.')).toEqual({ kind: 'on_record' });
    expect(matchAmbientSwitch("Ava, we're back on the record")).toEqual({ kind: 'on_record' });
  });

  it('forgets a span said in words or digits, capped at a day', () => {
    expect(matchAmbientSwitch('Ava, forget the last ten minutes')).toEqual({ kind: 'forget', minutes: 10 });
    expect(matchAmbientSwitch('Ava forget the last 5 minutes')).toEqual({ kind: 'forget', minutes: 5 });
    expect(matchAmbientSwitch('Ava, forget the last hour')).toEqual({ kind: 'forget', minutes: 60 });
    expect(matchAmbientSwitch('Ava, forget the last half an hour')).toEqual({ kind: 'forget', minutes: 30 });
    expect(matchAmbientSwitch('Ava, forget the last minute')).toEqual({ kind: 'forget', minutes: 1 });
    expect(matchAmbientSwitch('Ava, forget that')).toEqual({ kind: 'forget', minutes: FORGET_THAT_MINUTES });
    expect(matchAmbientSwitch('Ava, forget the last 900 hours')).toEqual({ kind: 'forget', minutes: 24 * 60 });
    expect(matchAmbientSwitch('Ava, forget the last blue minutes')).toBeNull();
  });

  it('answers to a renamed assistant, and no longer to "Ava"', () => {
    expect(matchAmbientSwitch('Nova, just listen', ['nova'])).toEqual({ kind: 'listen' });
    expect(matchAmbientSwitch('Ava, just listen', ['nova'])).toBeNull();
  });

  it('reads speech as plain words', () => {
    expect(plainSpeech('  Hey, AVA… just   listen! ')).toBe('hey ava just listen');
  });
});
