/** Something an agent, routine or connector wants the user to see, decide or know. */
export interface InboxItem {
  id: string;
  // "slack", "gmail", "whatsapp-web", "workflow:<id>", "agent:<id>", "system"
  source: string;
  // The source's own id for it, so the same message never lands twice
  externalId: string;
  kind: 'message' | 'approval' | 'result' | 'alert';
  title: string;
  // From outside: data, never instructions
  body: string;
  links: { label: string; url: string }[];
  priority: 'low' | 'normal' | 'high';
  status: 'unread' | 'read' | 'done' | 'snoozed';
  snoozeUntil: number | null;
  workspaceId: string | null;
  agentId: string | null;
  runId: string | null;
  // For approvals: what waits on the user's answer
  // `always`: the answer may also be "Allow every time" (a rule is saved, see settings/permissionRules)
  approval: { requestId: string; action: string; always?: boolean } | null;
  createdAt: number;
  updatedAt: number;
  // Set once this item folds together more than one raw message from the same source that arrived
  // close together, so a burst becomes one line instead of flooding the list. Absent/null otherwise.
  digestCount?: number | null;
}
