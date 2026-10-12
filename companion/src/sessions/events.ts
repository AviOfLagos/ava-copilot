import { sessionEventSchema } from '@protocol';
import type { SessionEvent } from '@protocol';

/**
 * eve's session stream (NDJSON, one event per line) as the protocol's session events. One eve event
 * becomes at most one protocol event with the same index, so a client that reconnects with
 * cursor = index + 1 never misses or repeats one. Events the extension has no use for are skipped
 * (their index still counts). Shapes as recorded by the spike (companion/spike/eve-probe/events-*.ndjson).
 */

type Data = Record<string, unknown>;

const text = (value: unknown, max = 100_000) => (typeof value === 'string' ? value.slice(0, max) : '');

export function mapEveEvent(raw: unknown, index: number): SessionEvent | null {
  const event = (raw ?? {}) as { type?: unknown; data?: unknown };
  const data = (event.data ?? {}) as Data;
  const turnId = text(data.turnId, 100);
  let mapped: SessionEvent | null = null;
  switch (event.type) {
    case 'session.started':
      mapped = { type: 'session.started', index };
      break;
    case 'turn.started':
      mapped = { type: 'turn.started', index, turnId };
      break;
    case 'message.appended':
      mapped = { type: 'message.delta', index, turnId, text: text(data.messageDelta) };
      break;
    case 'message.completed':
      mapped = { type: 'message', index, turnId, text: text(data.message), final: data.finishReason !== 'tool-calls' };
      break;
    case 'actions.requested': {
      const actions = Array.isArray(data.actions) ? (data.actions as Data[]) : [];
      mapped = {
        type: 'tool.called',
        index,
        turnId,
        calls: actions
          .filter(action => action.kind === 'tool-call')
          .map(action => ({
            callId: text(action.callId, 200),
            tool: text(action.toolName, 200),
            input: action.input ?? null,
          })),
      };
      break;
    }
    case 'action.result': {
      const result = (data.result ?? {}) as Data;
      mapped = {
        type: 'tool.result',
        index,
        turnId,
        callId: text(result.callId, 200),
        tool: text(result.toolName, 200),
        output: result.output ?? null,
        status: text(data.status, 40) || 'completed',
      };
      break;
    }
    case 'input.requested': {
      const requests = Array.isArray(data.requests) ? (data.requests as Data[]) : [];
      mapped = {
        type: 'approval.requested',
        index,
        turnId,
        approvals: requests.map(request => {
          const action = (request.action ?? {}) as Data;
          return {
            approvalId: text(request.requestId, 200),
            callId: text(action.callId, 200),
            tool: text(action.toolName, 200) || text(request.kind, 200),
            input: action.input ?? null,
            prompt: text(request.prompt, 1000),
          };
        }),
      };
      break;
    }
    case 'input.resolved': {
      const resolutions = Array.isArray(data.resolutions) ? (data.resolutions as Data[]) : [];
      mapped = {
        type: 'approval.resolved',
        index,
        turnId,
        resolutions: resolutions.map(resolution => ({
          approvalId: text(resolution.requestId, 200),
          outcome: text(resolution.outcome, 40),
        })),
      };
      break;
    }
    case 'turn.waiting':
      mapped = { type: 'turn.waiting', index, turnId, on: text(data.on, 40) || 'unknown' };
      break;
    case 'turn.completed': {
      const usage = (data.usage ?? null) as Data | null;
      mapped = {
        type: 'turn.completed',
        index,
        turnId,
        ...(usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
          ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
          : {}),
      };
      break;
    }
    case 'turn.failed': {
      const error = (data.error ?? {}) as Data;
      mapped = {
        type: 'turn.failed',
        index,
        turnId,
        message: text(error.message, 2000) || text(data.message, 2000) || 'The turn failed.',
      };
      break;
    }
    case 'turn.cancelled':
      mapped = { type: 'turn.cancelled', index, turnId };
      break;
    case 'session.waiting':
      mapped = { type: 'session.idle', index };
      break;
    case 'session.completed':
    case 'session.failed':
      mapped = {
        type: 'session.ended',
        index,
        reason: event.type === 'session.failed' ? text((data.error as Data)?.code, 200) || 'failed' : 'completed',
      };
      break;
    default:
      return null;
  }
  const checked = sessionEventSchema.safeParse(mapped);
  return checked.success ? checked.data : null;
}

/** Splits an NDJSON byte stream into parsed lines. */
export async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest);
}
