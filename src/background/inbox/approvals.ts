/**
 * Approve/decline from the Inbox, for any stream: a handler is registered per request-id prefix (the
 * workflows stream's is wired in register.ts, `workflow-step:`), and answering an item dispatches to
 * whichever prefix matches. Agents (WS5b) and connectors (WS4) plug in the same way later.
 */

export type ApprovalHandler = (requestId: string, approved: boolean) => Promise<boolean>;

interface Entry {
  prefix: string;
  handler: ApprovalHandler;
}

const handlers: Entry[] = [];

/** Registers what happens when an approval whose request id starts with `prefix` is answered. */
export function registerApprovalHandler(prefix: string, handler: ApprovalHandler): void {
  handlers.push({ prefix, handler });
}

/** Routes an answer to its handler by the request id's prefix. False when nothing claims that prefix. */
export async function answerApproval(requestId: string, approved: boolean): Promise<boolean> {
  const entry = handlers.find(candidate => requestId.startsWith(candidate.prefix));
  if (!entry) return false;
  return entry.handler(requestId, approved);
}

/** Test-only: clears every registered handler, so test files that register their own start clean. */
export function clearApprovalHandlersForTests(): void {
  handlers.length = 0;
}
