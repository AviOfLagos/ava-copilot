import { describe, expect, it, vi } from 'vitest';
import { APICallError, LoadAPIKeyError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { AppError } from '@extension/shared';
import { ResponseParseError } from '@src/background/agent/agents/errors';
import { fallbackReason } from '../errors';
import { callWithFallback, generatePlainText, generateStructured } from '../generate';
import { systemMessage, userMessage } from '../messages';
import type { ChatModel, FallbackReason } from '../types';
import { mockChatModel, textResult } from './mockModel';

const messages = [systemMessage('system'), userMessage('task')];

function apiError(statusCode: number | undefined, responseBody = '', message = `HTTP ${statusCode}`) {
  // Not retryable, so the SDK does not wait between attempts in these tests
  return new APICallError({
    message,
    url: 'https://cloud.test/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody,
    isRetryable: false,
  });
}

/** A cloud model whose calls throw `error`, and a local model that answers; the switch is recorded. */
function setup(error: unknown, localAnswer = 'local answer') {
  const cloudModel = new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });
  const cloud: ChatModel = {
    provider: 'gemini',
    modelName: 'gemini-3-flash',
    model: cloudModel,
    settings: {},
    structuredMode: 'native',
  };
  const local = mockChatModel(textResult(localAnswer), 'text', { provider: 'ollama', modelName: 'qwen3:4b' });
  const switches: { to: string; reason: FallbackReason }[] = [];
  const resolve = vi.fn(async () => local.chatModel);
  cloud.fallback = { resolve, onSwitch: (to, reason) => switches.push({ to: to.modelName, reason }) };
  return { cloud, cloudModel, local, switches, resolve };
}

describe('which errors fall back to the local model', () => {
  const cases: [string, unknown, FallbackReason][] = [
    ['a refused key (401)', apiError(401), 'auth'],
    ['a forbidden key (403)', apiError(403), 'forbidden'],
    ['a missing key', new LoadAPIKeyError({ message: 'no key' }), 'auth'],
    ['payment required (402)', apiError(402), 'quota'],
    ['a spent quota (429)', apiError(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}'), 'quota'],
    ['a rate limit the meter already waited out (429)', apiError(429, 'slow down'), 'rate_limit'],
    ['an outage (503)', apiError(503), 'unavailable'],
    ['no connection', apiError(undefined, '', 'Cannot connect to API: Failed to fetch'), 'network'],
    ['a timeout (408)', apiError(408), 'timeout'],
  ];
  for (const [name, error, reason] of cases) {
    it(`falls back on ${name}`, async () => {
      expect(fallbackReason(error)).toBe(reason);
      const { cloud, switches } = setup(error);
      expect(await generatePlainText({ chatModel: cloud, messages })).toBe('local answer');
      expect(switches).toEqual([{ to: 'qwen3:4b', reason }]);
    });
  }

  const never: [string, unknown][] = [
    ['a cancel', Object.assign(new Error('stopped'), { name: 'AbortError' })],
    ['a bad request caused by what we sent (400)', apiError(400)],
    ['a request too large (413)', apiError(413)],
    ['a budget', new AppError('budget', 'Over the limit.')],
    ['a reply that could not be parsed', new ResponseParseError('Could not parse')],
    ['an unknown model (404)', apiError(404)],
  ];
  for (const [name, error] of never) {
    it(`does not fall back on ${name}`, async () => {
      expect(fallbackReason(error)).toBeNull();
      const { cloud, resolve, switches } = setup(error);
      await expect(generatePlainText({ chatModel: cloud, messages })).rejects.toBe(error);
      expect(resolve).not.toHaveBeenCalled();
      expect(switches).toEqual([]);
    });
  }

  it('does not fall back when the call was cancelled, whatever the error says', async () => {
    const controller = new AbortController();
    const { cloud, resolve } = setup(apiError(503));
    const run = vi.fn(async () => {
      controller.abort();
      throw apiError(503);
    });
    await expect(callWithFallback(cloud, controller.signal, run)).rejects.toThrow('HTTP 503');
    expect(run).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the switch', () => {
  it('keeps the local model for the rest of the task, and tells the user once', async () => {
    const { cloud, cloudModel, local, switches } = setup(apiError(429, 'insufficient_quota'));
    await generatePlainText({ chatModel: cloud, messages });
    await generatePlainText({ chatModel: cloud, messages });
    expect(cloudModel.doGenerateCalls).toHaveLength(1);
    expect(local.model.doGenerateCalls).toHaveLength(2);
    expect(switches).toHaveLength(1);
  });

  it('runs a structured call again in the local model’s own mode', async () => {
    const { cloud, local } = setup(apiError(503), '{"answer":"from qwen"}');
    const { output } = await generateStructured({
      chatModel: cloud,
      messages,
      schema: z.object({ answer: z.string() }),
      name: 'output',
    });
    expect(output).toEqual({ answer: 'from qwen' });
    // Text mode: no response format sent to the local model
    expect(local.model.doGenerateCalls[0].responseFormat).toBeUndefined();
  });

  it('throws the cloud error when there is no local model, or it fails too', async () => {
    const error = apiError(401);
    const none = setup(error);
    none.resolve.mockResolvedValueOnce(null as unknown as ChatModel);
    await expect(generatePlainText({ chatModel: none.cloud, messages })).rejects.toBe(error);
    expect(none.switches).toEqual([]);

    const broken = setup(error);
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError(500);
      },
    });
    broken.resolve.mockResolvedValueOnce({ ...broken.local.chatModel, model: failing });
    await expect(generatePlainText({ chatModel: broken.cloud, messages })).rejects.toBe(error);
    expect(broken.switches).toEqual([]);
  });

  it('leaves a model without a fallback alone', async () => {
    const error = apiError(503);
    const { cloud } = setup(error);
    delete cloud.fallback;
    await expect(generatePlainText({ chatModel: cloud, messages })).rejects.toBe(error);
  });
});
