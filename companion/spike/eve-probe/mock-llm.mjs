// Spike only: an OpenAI-compatible chat server that records what each call saw (model, system text,
// tool names) and answers from a tiny script, streamed or not.
import http from 'node:http';

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map(part => part.text ?? '').join('');

export async function startMockLlm() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const system = request.messages
      .filter(message => message.role === 'system')
      .map(textOf)
      .join('\n');
    const tools = (request.tools ?? []).map(tool => tool.function?.name);
    const last = request.messages[request.messages.length - 1];
    calls.push({ model: request.model, system, tools, last: textOf(last), auth: req.headers.authorization ?? null });

    let reply;
    if (last?.role === 'tool') reply = { text: `TOOL RESULT: ${textOf(last)}` };
    else if (tools.includes('danger') && /use danger/i.test(textOf(last))) {
      reply = { tool: { name: 'danger', args: { to: 'boss@example.com' } } };
    } else reply = { text: `ECHO ${request.model}` };

    const id = 'chatcmpl-probe';
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (!request.stream) {
      const message = reply.tool
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
              },
            ],
          }
        : { role: 'assistant', content: reply.text };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model: request.model,
          choices: [{ index: 0, message, finish_reason: reply.tool ? 'tool_calls' : 'stop' }],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta, finish = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    if (reply.tool) {
      send(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
            },
          ],
        }),
      );
      send(chunk({}, 'tool_calls'));
    } else {
      send(chunk({ role: 'assistant', content: reply.text }));
      send(chunk({}, 'stop'));
    }
    send({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => server.close() };
}
