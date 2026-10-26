import type { ModelMessage, Telemetry, TelemetryOptions } from 'ai';
import { createLogger } from '@src/background/log';

/**
 * A trace of each turn (one message from the user and Ava's answer to it), with every model call the agents made for
 * it, as OpenTelemetry spans (OTLP/JSON, GenAI semantic conventions). Kept on this Mac: they go to Ava Brain, which
 * writes them to a file Suture reads to find answers that went wrong, replay them and verify fixes. Nothing here
 * sends them anywhere else.
 *
 * The model calls are recorded through the AI SDK's telemetry hooks: the agents pass `telemetryFor(taskId, agent)` to
 * each call, so a call is filed under its own turn even when several chats run at once.
 */

const logger = createLogger('traces');

// Long inputs (the page the navigator sees) are cut here: enough to read what went wrong, not a copy of the page
const MAX_TEXT = 20_000;
// A turn that never finishes (the service worker was stopped) is dropped after this
const MAX_TURN_MS = 30 * 60_000;

// Where an agent's behaviour lives in the repo, for Suture's trace → code mapping (suture.code_ref)
const CODE_REFS: Record<string, string> = {
  planner: 'src/background/agent/agents/planner.ts',
  navigator: 'src/background/agent/agents/navigator.ts',
};

type AttributeValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
export interface OtlpAttribute {
  key: string;
  value: AttributeValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}
/** An OTLP/JSON `ExportTraceServiceRequest` holding one turn. */
export interface OtlpTraceRequest {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

export type TraceSink = (request: OtlpTraceRequest) => Promise<void>;

export interface Turn {
  traceId: string;
  rootSpanId: string;
  startedAt: number;
  task: string;
  channel: string;
  spans: OtlpSpan[];
}

interface PendingCall {
  startedAt: number;
  provider: string;
  modelId: string;
  instructions?: string;
  messages: ModelMessage[];
}

const turns = new Map<string, Turn>();
let sink: TraceSink | null = null;
let version = '';

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [${text.length} chars]` : text);
const str = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): OtlpAttribute => ({ key, value: { intValue: String(Math.round(value)) } });

/** A message's words; pictures and files are named, not copied. */
function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(part => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text;
      if (part.type === 'tool-call') return `[tool call ${part.toolName}] ${JSON.stringify(part.input)}`;
      if (part.type === 'tool-result') return `[tool result ${part.toolName}] ${JSON.stringify(part.output)}`;
      return `[${part.type}]`;
    })
    .join('\n');
}

/** GenAI semantic-conventions messages: `[{ role, parts: [{ type: 'text', content }] }]` as JSON. */
function genAiMessages(messages: { role: string; text: string }[]): string {
  return JSON.stringify(messages.map(m => ({ role: m.role, parts: [{ type: 'text', content: clip(m.text) }] })));
}

/** Where finished turns go (Ava Brain), and the version they were made by. Until set, turns are not kept. */
export function setTraceSink(next: TraceSink | null, appVersion = ''): void {
  sink = next;
  version = appVersion;
}

/** A turn starts: the user's message, and where the chat is (whatsapp, user, voice…). */
export function startTurn(taskId: string, info: { task: string; channel?: string }): void {
  if (!sink) return;
  const now = Date.now();
  for (const [id, turn] of turns) if (now - turn.startedAt > MAX_TURN_MS) turns.delete(id);
  turns.set(taskId, {
    traceId: hex(16),
    rootSpanId: hex(8),
    startedAt: now,
    task: info.task,
    channel: info.channel ?? 'user',
    spans: [],
  });
}

/** The AI SDK telemetry options for one agent's model call in a turn; undefined when no turn is being recorded. */
export function telemetryFor(taskId: string, agent: string): TelemetryOptions | undefined {
  if (!turns.has(taskId)) return undefined;
  const pending = new Map<string, PendingCall>();
  const integration: Telemetry = {
    onStepStart: event => {
      pending.set(`${event.callId}:${event.stepNumber}`, {
        startedAt: Date.now(),
        provider: event.provider,
        modelId: event.modelId,
        instructions: typeof event.instructions === 'string' ? event.instructions : undefined,
        messages: event.messages ?? [],
      });
    },
    onStepEnd: event => {
      const key = `${event.callId}:${event.stepNumber}`;
      const call = pending.get(key);
      pending.delete(key);
      const turn = turns.get(taskId);
      if (!call || !turn) return;
      try {
        turn.spans.push(modelSpan(turn, agent, call, event));
      } catch (error) {
        logger.warning('A model call could not be recorded', error);
      }
    },
  };
  return { functionId: agent, integrations: [integration] };
}

function modelSpan(
  turn: Turn,
  agent: string,
  call: PendingCall,
  end: { text: string; finishReason: string; usage: { inputTokens?: number; outputTokens?: number } },
): OtlpSpan {
  const input = call.messages.map(m => ({ role: m.role, text: textOf(m.content) }));
  const system = [call.instructions ?? '', ...input.filter(m => m.role === 'system').map(m => m.text)].filter(Boolean);
  const attributes = [
    str('gen_ai.operation.name', 'chat'),
    str('gen_ai.provider.name', call.provider),
    str('gen_ai.request.model', call.modelId),
    str('gen_ai.agent.name', agent),
    str('gen_ai.conversation.id', turn.traceId),
    str('gen_ai.input.messages', genAiMessages(input.filter(m => m.role !== 'system'))),
    str('gen_ai.output.messages', genAiMessages([{ role: 'assistant', text: end.text }])),
    str('gen_ai.response.finish_reasons', JSON.stringify([end.finishReason])),
    str('suture.prompt_id', `ava.${agent}`),
    ...(system.length
      ? [str('gen_ai.system_instructions', JSON.stringify([{ type: 'text', content: clip(system.join('\n\n')) }]))]
      : []),
    ...(CODE_REFS[agent] ? [str('suture.code_ref', CODE_REFS[agent])] : []),
    ...(end.usage.inputTokens !== undefined ? [int('gen_ai.usage.input_tokens', end.usage.inputTokens)] : []),
    ...(end.usage.outputTokens !== undefined ? [int('gen_ai.usage.output_tokens', end.usage.outputTokens)] : []),
  ];
  return {
    traceId: turn.traceId,
    spanId: hex(8),
    parentSpanId: turn.rootSpanId,
    name: `chat ${call.modelId}`,
    kind: 3, // client
    startTimeUnixNano: nanos(call.startedAt),
    endTimeUnixNano: nanos(Date.now()),
    attributes,
    status: { code: 1 },
  };
}

/** The turn as an OTLP request: a root span (the user's message and the answer they got) over the model calls. */
export function turnRequest(
  turn: Turn,
  result: { answer: string; status: 'ok' | 'error' | 'cancelled'; error?: string },
  endedAt = Date.now(),
): OtlpTraceRequest {
  const root: OtlpSpan = {
    traceId: turn.traceId,
    spanId: turn.rootSpanId,
    name: 'invoke_agent ava',
    kind: 1, // internal
    startTimeUnixNano: nanos(turn.startedAt),
    endTimeUnixNano: nanos(endedAt),
    attributes: [
      str('gen_ai.operation.name', 'invoke_agent'),
      str('gen_ai.agent.name', 'ava'),
      str('gen_ai.conversation.id', turn.traceId),
      str('gen_ai.input.messages', genAiMessages([{ role: 'user', text: turn.task }])),
      str('gen_ai.output.messages', genAiMessages([{ role: 'assistant', text: result.answer }])),
      str('ava.channel', turn.channel),
      str('ava.status', result.status),
    ],
    status: result.status === 'error' ? { code: 2, message: result.error ?? 'error' } : { code: 1 },
  };
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            str('service.name', 'ava-copilot'),
            ...(version ? [str('service.version', version)] : []),
            str('ava.channel', turn.channel),
          ],
        },
        scopeSpans: [{ scope: { name: 'ava-copilot', version }, spans: [root, ...turn.spans] }],
      },
    ],
  };
}

/** The turn ended: its trace goes to the sink. Never throws, and never holds up the answer. */
export function finishTurn(
  taskId: string,
  result: { answer: string; status: 'ok' | 'error' | 'cancelled'; error?: string },
): void {
  const turn = turns.get(taskId);
  turns.delete(taskId);
  if (!turn || !sink) return;
  const send = sink;
  void Promise.resolve()
    .then(() => send(turnRequest(turn, result)))
    .catch(error => logger.debug('A trace was not kept', error));
}
