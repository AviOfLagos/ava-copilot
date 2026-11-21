import type { Proposal } from './queue';

/**
 * Tools, free first (docs/growth-team.md, Part 9). When an agent needs a tool it takes the first rung that
 * works. The ladder is code: a request for a later rung must say why each earlier one did not do, and a paid
 * tool is never asked for as a tool at all: it becomes a spending request against the budget.
 */

export const TOOL_RUNGS = ['connected', 'free_api', 'browser', 'free_tier', 'paid'] as const;
export type ToolRung = (typeof TOOL_RUNGS)[number];

export interface ToolAsk {
  // What the agent needs to do that it cannot do now
  need: string;
  // The tool or site
  tool: string;
  rung: ToolRung;
  // Why the cheaper rungs did not do
  tried: string;
  // The exact clicks for the user (a new account, a connector to add)
  steps: string;
  // For a paid tool: the price, and the result expected from it
  costUsd: number;
  expected: string;
}

export type ToolAnswer =
  // No request: the agent already has a way, and is told to use it
  | { kind: 'use_it'; text: string }
  // A request for the user
  | {
      kind: 'propose';
      proposal: Pick<Proposal, 'action' | 'title' | 'body' | 'target' | 'why' | 'amountUsd' | 'fields'>;
    }
  | { kind: 'refused'; why: string };

const MIN_TRIED = 12;

/** What a tool request becomes, by its rung. */
export function toolRequest(ask: ToolAsk): ToolAnswer {
  const need = ask.need.trim();
  const tool = ask.tool.trim();
  if (!need || !tool) return { kind: 'refused', why: 'Say what you need to do and which tool or site would do it.' };

  if (ask.rung === 'connected') {
    return {
      kind: 'use_it',
      text: `"${tool}" is already connected: use it. No request is needed for something you already have.`,
    };
  }
  if (ask.rung === 'browser') {
    return {
      kind: 'use_it',
      text: `Use ${tool} in the browser, in the account already signed in. No request is needed for that; if it asks for a sign-in, stop and say so.`,
    };
  }
  // Every later rung has to show the earlier ones were looked at
  if (ask.tried.trim().length < MIN_TRIED) {
    return {
      kind: 'refused',
      why: 'Free first: say in `tried` what is already connected, which free API or MCP server you looked at, and why the site in the browser does not do, before asking for more.',
    };
  }
  if (ask.rung === 'free_api') {
    return {
      kind: 'propose',
      proposal: {
        action: 'tool',
        title: `Connect ${tool} (free)`,
        body: `${need}\n\nSteps for you:\n${ask.steps.trim() || 'Add it in Connections.'}`,
        target: tool,
        why: ask.tried.trim(),
        fields: { 'Tried first': ask.tried.trim() },
      },
    };
  }
  if (ask.rung === 'free_tier') {
    if (!ask.steps.trim()) {
      return {
        kind: 'refused',
        why: 'A free tier needs a new account, which only the user can make: give the exact clicks in `steps`.',
      };
    }
    return {
      kind: 'propose',
      proposal: {
        action: 'new_account',
        title: `Open a free ${tool} account`,
        body: `${need}\n\nSteps for you:\n${ask.steps.trim()}`,
        target: tool,
        why: ask.tried.trim(),
        fields: { 'Tried first': ask.tried.trim() },
      },
    };
  }
  // Paid: never a tool request, always a spending request with its four answers
  return {
    kind: 'propose',
    proposal: {
      action: 'spend',
      title: `Pay for ${tool}`,
      body: need,
      target: tool,
      why: ask.tried.trim(),
      amountUsd: ask.costUsd,
      fields: { buys: tool, triedFree: ask.tried.trim(), expected: ask.expected.trim() },
    },
  };
}
