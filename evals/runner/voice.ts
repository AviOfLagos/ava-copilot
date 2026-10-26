import { expect, vi } from 'vitest';
import type { EconomyTurnReply, EconomyTurnRequest } from '@src/background/voice/engines/protocol';
import type { VoiceEvents } from '@src/offscreen/voice';
import { EconomySession } from '@src/offscreen/stt/economy';
import type { EconomyDeps, EconomyOptions } from '@src/offscreen/stt/economy';
import type { SttEngine } from '@src/offscreen/stt/engines';
import type { VoiceCase } from './cases';

/**
 * Plays what was heard into the on-device voice conversation (economy mode) and collects the turns Ava answers.
 * The microphone is synthetic: a quarter second of a tone is a quarter second of speech, its amplitude how near the
 * speaker is, and the session's clock moves only with the audio fed in, so a case runs the same on any machine.
 */

const CHUNK = 4096;
const LEVELS = { near: 0.2, far: 0.03 };
// Her voice's echo tail after she speaks
const ECHO_TAIL_MS = 400;
const tone = (amplitude: number) => Float32Array.from({ length: CHUNK }, (_, i) => amplitude * Math.sin(i / 3));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

export async function runVoiceCase(evalCase: VoiceCase): Promise<void> {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    let onChunk: (samples: Float32Array) => void = () => {};
    const mic = (samples: Float32Array) => {
      clock += (samples.length / 16_000) * 1000;
      onChunk(samples);
    };
    const words: string[] = [];
    const stt: SttEngine = {
      load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
      transcribe: vi.fn(async () => words.shift() ?? ''),
      dispose: vi.fn(),
    };
    let finishSpeaking: () => void = () => {};
    const asked: string[] = [];
    const deps = {
      openMic: vi.fn(async (chunks: (samples: Float32Array) => void) => {
        onChunk = chunks;
        return () => {};
      }),
      loadStt: vi.fn(async () => stt),
      releaseStt: vi.fn(),
      speak: vi.fn(() => new Promise<void>(resolve => (finishSpeaking = resolve))),
      stopSpeaking: vi.fn(() => finishSpeaking()),
      warmVoice: vi.fn(async () => {}),
      ask: vi.fn(async (request: EconomyTurnRequest): Promise<EconomyTurnReply> => {
        asked.push(request.heard ?? '');
        return { said: 'Okay.' };
      }),
    } satisfies EconomyDeps;
    const options: EconomyOptions = {
      mode: 'economy',
      instructions: 'You are Ava Copilot.',
      tools: [],
      economy: {
        stt: { engine: 'moonshine', model: 'moonshine-tiny', webgpu: false },
        tts: { engine: 'kitten', voice: 'Bella', rate: 1 },
      },
      assistantName: evalCase.assistant_name,
    };
    const events = { onTurn: vi.fn(), onTool: vi.fn(), onStatus: vi.fn(), onUsage: vi.fn() } satisfies VoiceEvents;
    const session = new EconomySession(options, events, deps);
    await session.start();

    // When she answered a turn, she speaks; once she is done, her echo fades before the next words count
    let answered = 0;
    const afterAnswers = async () => {
      await tick(5);
      while (answered < asked.length) {
        answered++;
        await vi.waitFor(() => expect(deps.speak).toHaveBeenCalledTimes(answered));
        finishSpeaking();
        await tick();
        clock += ECHO_TAIL_MS;
      }
    };

    for (const step of evalCase.heard) {
      if ('say' in step) {
        words.push(step.say);
        const before = (stt.transcribe as ReturnType<typeof vi.fn>).mock.calls.length;
        for (let i = 0; i < 6; i++) mic(tone(LEVELS[step.level]));
        for (let i = 0; i < step.pause; i++) mic(new Float32Array(CHUNK));
        await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalledTimes(before + 1));
        await tick();
      } else if ('quiet' in step) {
        for (let i = 0; i < step.quiet; i++) mic(new Float32Array(CHUNK));
      } else {
        clock += step.wait_ms;
      }
      await afterAnswers();
    }
    // Words that stop mid-clause wait a second more: let the last turn end
    for (let i = 0; i < 6; i++) mic(new Float32Array(CHUNK));
    await afterAnswers();
    expect(asked, 'turns Ava answered').toEqual(evalCase.expect.turns);
    await session.stop?.();
  } finally {
    vi.restoreAllMocks();
  }
}
