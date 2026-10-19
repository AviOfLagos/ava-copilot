import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerOneOff, dispatchCommand, registerCommand, registerRecovery, runRecoveries } from '../index';

describe('answerOneOff', () => {
  const ask = (message: Record<string, unknown>) =>
    new Promise<unknown[]>(resolve => {
      const answers: unknown[] = [];
      expect(answerOneOff(message, answer => answers.push(answer))).toBe(true);
      setTimeout(() => resolve(answers), 10);
    });

  it('answers a one-off message exactly once on every path', async () => {
    registerCommand('oneoff_ok', z.object({ type: z.literal('oneoff_ok') }), (_input, context) =>
      context.reply({ type: 'oneoff_ok', requestId: context.requestId }),
    );
    registerCommand('oneoff_throws', z.object({ type: z.literal('oneoff_throws') }), async () => {
      throw new Error('broke');
    });
    registerCommand('oneoff_silent', z.object({ type: z.literal('oneoff_silent') }), () => {});

    expect(await ask({ type: 'oneoff_ok', requestId: 'a' })).toEqual([{ type: 'oneoff_ok', requestId: 'a' }]);
    expect(await ask({ type: 'oneoff_throws', requestId: 'b' })).toEqual([
      { type: 'error', requestId: 'b', error: 'broke' },
    ]);
    expect(await ask({ type: 'oneoff_silent' })).toEqual([{ type: 'done', requestId: null }]);
    expect(await ask({ type: 'oneoff_nobody' })).toEqual([
      { type: 'error', requestId: null, error: 'Unknown request.' },
    ]);
  });
});

describe('registerCommand / dispatchCommand', () => {
  it('runs a registered command with checked input, refuses bad input, and leaves unknown ones', async () => {
    const seen: unknown[] = [];
    registerCommand(
      'test_echo',
      z.object({ type: z.literal('test_echo'), text: z.string().max(5) }),
      (input, context) => {
        seen.push(input.text);
        context.reply({ type: 'test_echoed', requestId: context.requestId, text: input.text });
      },
    );
    const replies: Record<string, unknown>[] = [];
    const context = { reply: (message: Record<string, unknown>) => void replies.push(message), requestId: 'r1' };

    expect(await dispatchCommand({ type: 'test_echo', text: 'hi' } as never, context)).toBe(true);
    expect(seen).toEqual(['hi']);
    expect(replies[0]).toMatchObject({ type: 'test_echoed', requestId: 'r1' });

    // Too long: refused before the handler sees it
    expect(await dispatchCommand({ type: 'test_echo', text: 'far too long' } as never, context)).toBe(true);
    expect(seen).toEqual(['hi']);
    expect(replies[1]).toMatchObject({ type: 'error', requestId: 'r1' });

    expect(await dispatchCommand({ type: 'nobody' } as never, context)).toBe(false);
    expect(() => registerCommand('test_echo', z.object({}), () => {})).toThrow(/twice/);
  });
});

describe('registerRecovery', () => {
  it('runs every recovery, even after one fails', async () => {
    const ran: string[] = [];
    registerRecovery('broken', async () => {
      throw new Error('x');
    });
    registerRecovery('fine', async () => void ran.push('fine'));
    await runRecoveries();
    expect(ran).toEqual(['fine']);
  });
});
