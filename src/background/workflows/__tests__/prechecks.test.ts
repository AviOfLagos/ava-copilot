import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { AgentProfile, RunRecord, WorkflowRecord } from '@extension/storage';
import { NEEDS_NEX_BRAIN, prechecksFor } from '../prechecks';
import type { PrecheckDeps } from '../prechecks';
import type { WorkflowNode } from '../spec';
import { newWorkflowRecord } from '../store';

vi.mock('webextension-polyfill', () => ({ default: {} }));

function deps(over: Partial<PrecheckDeps> = {}): PrecheckDeps {
  return {
    brainPaired: async () => false,
    agents: async () => [],
    connectors: { prepare: async () => ({ refused: 'nope' }) },
    database: new AviCopilotDb(`prechecks-${crypto.randomUUID()}`),
    ...over,
  } as PrecheckDeps;
}

const workflow: WorkflowRecord = newWorkflowRecord({ name: 'Routine', workspaceId: 'ws1' });
const run = {
  id: 'r1',
  startedAt: 0,
  trigger: { type: 'manual', detail: '' },
  workspaceId: 'ws1',
  agentId: null,
} as RunRecord;
const context = (node: WorkflowNode) => ({
  node,
  params: node as unknown as Record<string, unknown>,
  run,
  workflow,
  signal: new AbortController().signal,
});

describe('checks before a step asks for the user’s click', () => {
  it('a sandbox step needs Nex Brain paired, and says where to pair it', async () => {
    const node: WorkflowNode = { id: 'code', type: 'step.sandbox', label: 'Code', command: 'make' };
    await expect(prechecksFor(deps())['step.sandbox']!(context(node))).rejects.toThrow(NEEDS_NEX_BRAIN);
    expect(NEEDS_NEX_BRAIN).toMatch(/Settings › Nex Brain/);
    await expect(
      prechecksFor(deps({ brainPaired: async () => true }))['step.sandbox']!(context(node)),
    ).resolves.toBeUndefined();
  });

  it('an agent step needs an agent by that name, in the routine’s workspace', async () => {
    const node: WorkflowNode = { id: 'a', type: 'step.agent', label: 'Agent', task: 'Check', agent: 'Scout' };
    const agent = (name: string, workspaceId: string | null, status = 'active') =>
      ({ id: name, name, workspaceId, status }) as unknown as AgentProfile;
    const check = (agents: AgentProfile[]) => prechecksFor(deps({ agents: async () => agents }))['step.agent']!;
    await expect(check([agent('Writer', null)])(context(node))).rejects.toThrow(
      /There is no agent "Scout"; your agents: "Writer"/,
    );
    await expect(check([agent('Scout', 'other')])(context(node))).rejects.toThrow(/no agent/);
    await expect(check([agent('Scout', null, 'draft')])(context(node))).rejects.toThrow(/no agent/);
    await expect(check([agent('Scout', 'ws1')])(context(node))).resolves.toBeUndefined();
    await expect(check([])(context({ ...node, agent: '' }))).rejects.toThrow(/names no agent/);
  });

  it('a tool step needs its connector and tool, said for a routine rather than a chat', async () => {
    const node: WorkflowNode = {
      id: 't',
      type: 'step.tool',
      label: 'Post',
      connector: 'Slack',
      tool: 'post',
      args: '{"text": "hi"}',
      readOnly: false,
    };
    const prepare = vi.fn(async () => ({ refused: 'There is no connector "Slack" for this chat.' }));
    await expect(prechecksFor(deps({ connectors: { prepare } as never }))['step.tool']!(context(node))).rejects.toThrow(
      /no connector "Slack"/,
    );
    expect(prepare).toHaveBeenCalledWith({ workspaceId: 'ws1', agentId: null }, 'Slack', 'post', { text: 'hi' });

    const noWorkspace = vi.fn(async () => ({
      refused: 'This chat is in no workspace, and connectors are bound to workspaces: the user can move the chat.',
    }));
    await expect(
      prechecksFor(deps({ connectors: { prepare: noWorkspace } as never }))['step.tool']!(context(node)),
    ).rejects.toThrow(/This routine is in no workspace/);

    const ready = vi.fn(async () => ({ connector: {}, fingerprint: {}, policy: 'ask', args: {} }));
    await expect(
      prechecksFor(deps({ connectors: { prepare: ready } as never }))['step.tool']!(context(node)),
    ).resolves.toBeUndefined();
  });
});
