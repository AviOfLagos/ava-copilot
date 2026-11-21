import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerApproval, clearApprovalHandlersForTests, registerApprovalHandler } from '../approvals';

beforeEach(() => {
  clearApprovalHandlersForTests();
});

describe('answerApproval', () => {
  it('routes to the handler whose prefix matches the request id', async () => {
    const workflowService = { answerRequest: vi.fn().mockResolvedValue(true) };
    registerApprovalHandler('workflow-step:', (requestId, approved) =>
      workflowService.answerRequest(requestId, approved),
    );

    const ok = await answerApproval('workflow-step:run1:node1', true);
    expect(ok).toBe(true);
    expect(workflowService.answerRequest).toHaveBeenCalledWith('workflow-step:run1:node1', true);
  });

  it('passes the approve/decline choice through unchanged', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerApprovalHandler('agent-step:', handler);
    await answerApproval('agent-step:run2:node2', false);
    expect(handler).toHaveBeenCalledWith('agent-step:run2:node2', false, {});
  });

  it('passes "Allow every time" on to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerApprovalHandler('team-item:', handler);
    await answerApproval('team-item:x', true, { always: true });
    expect(handler).toHaveBeenCalledWith('team-item:x', true, { always: true });
  });

  it('tries handlers in registration order and stops at the first matching prefix', async () => {
    const first = vi.fn().mockResolvedValue(true);
    const second = vi.fn().mockResolvedValue(true);
    registerApprovalHandler('a:', first);
    registerApprovalHandler('a:b:', second);
    await answerApproval('a:b:1', true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('is false when nothing claims the prefix, and calls no handler', async () => {
    const handler = vi.fn();
    registerApprovalHandler('workflow-step:', handler);
    expect(await answerApproval('connector-step:1', true)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
