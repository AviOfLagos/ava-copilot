import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { systemMessage, userMessage } from '@src/background/llm/messages';
import { generateStructured, zodSchema } from '@src/background/llm/generate';
import { mockChatModel, textResult } from '@src/background/llm/__tests__/mockModel';
import { z } from 'zod';
import { finishTurn, setTraceSink, startTurn, telemetryFor } from '../traces';
import type { OtlpSpan, OtlpTraceRequest } from '../traces';

const attr = (span: OtlpSpan, key: string) => {
  const value = span.attributes.find(a => a.key === key)?.value;
  return value && ('stringValue' in value ? value.stringValue : 'intValue' in value ? value.intValue : value.boolValue);
};

async function recordTurn(task: string, replies: string[], channel = 'whatsapp'): Promise<OtlpTraceRequest> {
  const sent: OtlpTraceRequest[] = [];
  setTraceSink(async request => void sent.push(request), '0.2.3');
  startTurn('thread-1', { task, channel });
  const { chatModel } = mockChatModel(replies.map(text => textResult(text)));
  let answer = '';
  for (let i = 0; i < replies.length; i++) {
    const { output } = await generateStructured({
      chatModel,
      messages: [systemMessage('You are the planner.'), userMessage(task)],
      schema: zodSchema(z.object({ final_answer: z.string() })),
      name: 'planner_output',
      telemetry: telemetryFor('thread-1', 'planner'),
    });
    answer = output.final_answer;
  }
  finishTurn('thread-1', { answer, status: 'ok' });
  await new Promise(resolve => setTimeout(resolve, 0));
  return sent[0];
}

afterEach(() => setTraceSink(null));

describe('turn traces', () => {
  it('records the turn as OTLP/JSON: the message and answer on the root, each model call under it', async () => {
    const trace = await recordTurn('Hi', ['{"final_answer":"None"}', '{"final_answer":"Hi Avi!"}']);
    const [root, ...calls] = trace.resourceSpans[0].scopeSpans[0].spans;
    expect(trace.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'ava-copilot' },
    });
    expect(attr(root, 'gen_ai.operation.name')).toBe('invoke_agent');
    expect(attr(root, 'ava.channel')).toBe('whatsapp');
    expect(JSON.parse(String(attr(root, 'gen_ai.input.messages')))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hi' }] },
    ]);
    expect(JSON.parse(String(attr(root, 'gen_ai.output.messages')))[0].parts[0].content).toBe('Hi Avi!');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.traceId).toBe(root.traceId);
      expect(call.parentSpanId).toBe(root.spanId);
      expect(attr(call, 'gen_ai.agent.name')).toBe('planner');
      expect(attr(call, 'suture.code_ref')).toBe('src/background/agent/agents/planner.ts');
      expect(String(attr(call, 'gen_ai.system_instructions'))).toContain('You are the planner.');
    }
    expect(JSON.parse(String(attr(calls[0], 'gen_ai.output.messages')))[0].parts[0].content).toBe(
      '{"final_answer":"None"}',
    );
    expect(attr(calls[0], 'gen_ai.usage.input_tokens')).toBe('10');
  });

  it('keeps nothing without a sink, and a call outside a turn is not recorded', async () => {
    setTraceSink(null);
    startTurn('thread-2', { task: 'Hi' });
    expect(telemetryFor('thread-2', 'planner')).toBeUndefined();
  });

  it('never fails the turn when the sink does', async () => {
    setTraceSink(async () => {
      throw new Error('Ava Brain is not paired');
    });
    startTurn('thread-3', { task: 'Hi' });
    expect(() => finishTurn('thread-3', { answer: 'Hello', status: 'ok' })).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  // The planted failure Suture's Ava loop starts from: AVA_TRACE_FIXTURE=<path> pnpm vitest run traces
  it.skipIf(!process.env.AVA_TRACE_FIXTURE)('writes a "None" turn for Suture', async () => {
    const trace = await recordTurn('Hi', [
      JSON.stringify({
        observation: '',
        challenges: '',
        done: true,
        next_steps: '',
        final_answer: 'None',
        reasoning: '',
        web_task: false,
      }),
    ]);
    writeFileSync(process.env.AVA_TRACE_FIXTURE!, `${JSON.stringify(trace)}\n`);
  });
});
