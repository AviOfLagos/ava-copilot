import { describe, expect, it } from 'vitest';
import {
  createPullProgress,
  hasOllamaModel,
  listOllamaModels,
  ollamaRoot,
  parsePullLine,
  pullOllamaModel,
} from '../ollama';

/** A fetch answering a pull with these lines, in chunks that split lines anywhere. */
function pullFetch(lines: string[], chunk = 7, status = 200): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = lines.join('\n');
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
        controller.close();
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'nomic-embed-text', stream: true });
    return new Response(status === 200 ? stream : body, { status });
  }) as unknown as typeof fetch;
}

describe('Ollama pull', () => {
  it('reads one line of the answer', () => {
    expect(parsePullLine('{"status":"pulling manifest"}')).toEqual({ status: 'pulling manifest' });
    expect(parsePullLine('{"status":"pulling a1","digest":"a1","total":10,"completed":4}')).toEqual({
      status: 'pulling a1',
      digest: 'a1',
      total: 10,
      completed: 4,
    });
    expect(parsePullLine('{"error":"pull model manifest: file does not exist"}')).toEqual({
      status: 'error',
      error: 'pull model manifest: file does not exist',
    });
    expect(parsePullLine('')).toBeNull();
    expect(parsePullLine('not json')).toBeNull();
    expect(parsePullLine('{"other":1}')).toBeNull();
  });

  it('sums the layers into one progress and ends at the total on success', () => {
    const progress = createPullProgress();
    expect(progress({ status: 'pulling manifest' })).toEqual({ received: 0, total: 0, status: 'pulling manifest' });
    expect(progress({ status: 'p', digest: 'a', total: 100, completed: 40 })).toMatchObject({
      received: 40,
      total: 100,
    });
    expect(progress({ status: 'p', digest: 'b', total: 50, completed: 10 })).toMatchObject({
      received: 50,
      total: 150,
    });
    // A layer never goes back, and never past its size
    expect(progress({ status: 'p', digest: 'a', total: 100, completed: 30 })).toMatchObject({ received: 50 });
    expect(progress({ status: 'p', digest: 'b', total: 50, completed: 99 })).toMatchObject({ received: 90 });
    expect(progress({ status: 'success' })).toMatchObject({ received: 150, total: 150, status: 'success' });
  });

  it('streams a pull to the end, with progress', async () => {
    const seen: { received: number; total: number; status: string }[] = [];
    await pullOllamaModel(
      'http://localhost:11434',
      'nomic-embed-text',
      progress => seen.push(progress),
      new AbortController().signal,
      pullFetch([
        '{"status":"pulling manifest"}',
        '{"status":"pulling 970aa","digest":"970aa","total":200,"completed":50}',
        '{"status":"pulling 970aa","digest":"970aa","total":200,"completed":200}',
        '{"status":"verifying sha256 digest"}',
        '{"status":"success"}',
      ]),
    );
    expect(seen.map(item => item.received)).toEqual([0, 50, 200, 200, 200]);
    expect(seen.at(-1)).toMatchObject({ total: 200, status: 'success' });
  });

  it('fails on an error line, an error status, or an answer that stops early', async () => {
    const signal = new AbortController().signal;
    await expect(
      pullOllamaModel('r', 'nomic-embed-text', () => {}, signal, pullFetch(['{"error":"no space left"}'])),
    ).rejects.toThrow('no space left');
    await expect(
      pullOllamaModel('r', 'nomic-embed-text', () => {}, signal, pullFetch(['{"error":"forbidden"}'], 7, 403)),
    ).rejects.toThrow('forbidden');
    await expect(
      pullOllamaModel('r', 'nomic-embed-text', () => {}, signal, pullFetch(['{"status":"pulling manifest"}'])),
    ).rejects.toThrow(/stopped/);
  });

  it('knows the server root and model names', async () => {
    expect(ollamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(ollamaRoot('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
    expect(ollamaRoot('')).toBe('http://localhost:11434');
    expect(hasOllamaModel(['nomic-embed-text:latest', 'qwen3:4b'], 'nomic-embed-text')).toBe(true);
    expect(hasOllamaModel(['qwen3:4b'], 'qwen3:8b')).toBe(false);
    const tags = (async () =>
      new Response(
        JSON.stringify({ models: [{ name: 'qwen3:4b' }, { model: 'gemma3:4b' }] }),
      )) as unknown as typeof fetch;
    await expect(listOllamaModels('r', tags)).resolves.toEqual(['qwen3:4b', 'gemma3:4b']);
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(listOllamaModels('r', down)).resolves.toBeNull();
  });
});
