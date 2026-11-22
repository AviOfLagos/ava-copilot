import { describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { mockChatModel, textResult, toolCallResult } from '../../../llm/__tests__/mockModel';
import type { MockResult } from '../../../llm/__tests__/mockModel';
import { END_CONVERSATION, runEconomyTurn, TOOLS_REFUSED_SENTENCE, turnMessages } from '../economy';
import type { EconomyBrainDeps } from '../economy';
import type { EconomyTurnRequest } from '../protocol';

const TOOLS: EconomyTurnRequest['tools'] = [
  { name: 'get_status', description: 'Says which tasks are running.' },
  {
    name: 'run_browser_task',
    description: 'Runs a task in the browser.',
    parameters: {
      type: 'OBJECT',
      properties: { task: { type: 'STRING', description: 'what to do' }, continue_last: { type: 'BOOLEAN' } },
      required: ['task'],
    },
  },
  { name: END_CONVERSATION, description: 'Ends the conversation.' },
];

const turn = (changes: Partial<EconomyTurnRequest> = {}): EconomyTurnRequest => ({
  type: 'voice_engine_turn',
  heard: 'what is going on',
  history: [],
  instructions: 'You are Ava Copilot.',
  tools: TOOLS,
  ...changes,
});

function brain(results: MockResult | MockResult[], changes: Partial<EconomyBrainDeps> = {}, local = false) {
  const { chatModel, model } = mockChatModel(results);
  const runTool = vi.fn(async (name: string) => (name === 'get_status' ? 'Nothing is running.' : 'Done.'));
  const deps: EconomyBrainDeps = {
    model: async () => ({ chatModel, local }),
    runTool,
    overBudget: async () => false,
    capSentence: 'The daily cost cap is reached.',
    ...changes,
  };
  return { deps, model, runTool };
}

describe('runEconomyTurn', () => {
  it('heard words → a voice tool → an answer to speak', async () => {
    const { deps, model, runTool } = brain([
      toolCallResult('get_status', {}),
      textResult('Nothing is running right now.'),
    ]);

    const reply = await runEconomyTurn(turn(), deps);

    expect(reply).toEqual({ said: 'Nothing is running right now.' });
    expect(runTool).toHaveBeenCalledWith('get_status', {}, 'what is going on');
    expect(model.doGenerateCalls).toHaveLength(2);
    // The model was offered the voice tools as JSON Schema, and got the tool result back
    const first = model.doGenerateCalls[0];
    expect(first.tools?.map(tool => tool.name)).toEqual(['get_status', 'run_browser_task', END_CONVERSATION]);
    const runTask = first.tools?.find(tool => tool.name === 'run_browser_task') as { inputSchema: unknown };
    expect(runTask.inputSchema).toMatchObject({
      type: 'object',
      properties: { task: { type: 'string' }, continue_last: { type: 'boolean' } },
      required: ['task'],
    });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('Nothing is running.');
  });

  it('passes tool arguments through, and the instructions with the voice rules first', async () => {
    const { deps, model, runTool } = brain([
      toolCallResult('run_browser_task', { task: 'open the inbox' }),
      textResult('Started it.'),
    ]);

    await runEconomyTurn(turn({ heard: 'open my inbox' }), deps);

    expect(runTool).toHaveBeenCalledWith('run_browser_task', { task: 'open the inbox' }, 'open my inbox');
    const system = JSON.stringify(model.doGenerateCalls[0].prompt[0]);
    expect(system).toContain('read aloud by a small voice');
    expect(system).toContain('You are Ava Copilot.');
  });

  it('stops at end_conversation and says nothing more', async () => {
    const { deps, model, runTool } = brain([toolCallResult(END_CONVERSATION, {}), textResult('Bye!')]);

    const reply = await runEconomyTurn(turn({ heard: "goodbye, that's all" }), deps);

    expect(reply).toEqual({ said: '', ended: true });
    expect(runTool).toHaveBeenCalledWith(END_CONVERSATION, {}, "goodbye, that's all");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('says nothing, and is no error, when the model has nothing to say', async () => {
    const { deps } = brain(textResult(''));
    expect(await runEconomyTurn(turn(), deps)).toEqual({ said: '' });
    const empty = brain({ ...textResult(''), content: [] });
    expect(await runEconomyTurn(turn(), empty.deps)).toEqual({ said: '' });
  });

  it('makes the answer speakable: no markdown, no links', async () => {
    const { deps } = brain(textResult('**Done.** It is on [the page](https://example.com).'));
    expect((await runEconomyTurn(turn(), deps)).said).toBe('Done. It is on the page.');
  });

  it('passes a notice on in one sentence', async () => {
    const { deps, model } = brain(textResult('Your task is done.'));
    await runEconomyTurn(turn({ heard: undefined, notice: '"Inbox" is done.' }), deps);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      'System notice. Tell the user, in one short sentence: \\"Inbox\\" is done.',
    );
  });

  it('stops at the daily cap with a paid model, but a local model is free', async () => {
    const paid = brain(textResult('Hello.'), { overBudget: async () => true });
    expect(await runEconomyTurn(turn(), paid.deps)).toEqual({ said: 'The daily cost cap is reached.', ended: true });
    expect(paid.model.doGenerateCalls).toHaveLength(0);

    const local = brain(textResult('Hello.'), { overBudget: async () => true }, true);
    expect(await runEconomyTurn(turn(), local.deps)).toEqual({ said: 'Hello.' });
  });

  it('says why, and never answers without tools, when the model cannot use them', async () => {
    const { chatModel } = mockChatModel(textResult('unused'));
    let calls = 0;
    const model = {
      ...(chatModel.model as object),
      doGenerate: async (options: { tools?: unknown[] }) => {
        calls++;
        if (options.tools?.length) {
          throw new APICallError({
            message: 'model does not support tools',
            url: 'http://localhost:11434',
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: false,
          });
        }
        return textResult("I can't access your past conversations or your vault.");
      },
    };
    const reply = await runEconomyTurn(turn(), {
      model: async () => ({ chatModel: { ...chatModel, model: model as never }, local: true }),
      runTool: vi.fn(),
      overBudget: async () => false,
      capSentence: '',
    });
    expect(reply).toEqual({ said: TOOLS_REFUSED_SENTENCE });
    // Asked once, with tools; never again without them
    expect(calls).toBe(1);
    expect(reply.said).not.toMatch(/can't access/);
  });

  it('turns a failure into a plain reason, with nothing to say', async () => {
    const reply = await runEconomyTurn(turn(), {
      model: async () => {
        throw new Error('No model can do "fast" work yet. Add a provider in Models & usage.');
      },
      runTool: vi.fn(),
      overBudget: async () => false,
      capSentence: '',
    });
    expect(reply).toEqual({ said: '', error: 'No model can do "fast" work yet. Add a provider in Models & usage.' });
  });
});

describe('turnMessages', () => {
  it('replays the conversation, notices marked, and joins turns of one role in a row', () => {
    const messages = turnMessages(
      turn({
        heard: 'and tomorrow?',
        history: [
          { heard: 'what is on today', said: 'Two meetings.' },
          { heard: '"Inbox" is done.', said: '', notice: true },
        ],
      }),
    );
    expect(messages).toEqual([
      { role: 'user', content: 'what is on today' },
      { role: 'assistant', content: 'Two meetings.' },
      {
        role: 'user',
        content: 'System notice. Tell the user, in one short sentence: "Inbox" is done.\nand tomorrow?',
      },
    ]);
  });

  it('never starts with the assistant', () => {
    const messages = turnMessages(turn({ heard: 'hi', history: [{ heard: '', said: 'Hello there.' }] }));
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
