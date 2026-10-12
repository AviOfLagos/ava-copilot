import type { ConnectorRecord, ToolFingerprint, ToolPolicy } from './types';

/**
 * What decides whether a connector's tool may run. Pure, shared by the background (which enforces it) and the
 * panel (which shows it).
 */

// Where a tool stands with the user: approved as it is, never reviewed, changed since approved, or gone
export type ConnectorToolState = 'ok' | 'new' | 'changed' | 'missing';

export function connectorToolState(
  fingerprint: Pick<ToolFingerprint, 'approved' | 'everApproved' | 'missing'>,
): ConnectorToolState {
  if (fingerprint.missing) return 'missing';
  if (fingerprint.approved) return 'ok';
  return fingerprint.everApproved ? 'changed' : 'new';
}

/** The policy a tool has once the user approved it: what they chose, else asking first. */
export function chosenToolPolicy(connector: Pick<ConnectorRecord, 'toolPolicy'>, tool: string): ToolPolicy {
  const policy = connector.toolPolicy?.[tool];
  return policy === 'read' || policy === 'approve' || policy === 'off' ? policy : 'approve';
}

/**
 * How a tool may run right now: off when the connector is off or not usable, or the tool is new, changed or gone;
 * else what the user chose for it.
 */
export function effectiveToolPolicy(
  connector: Pick<ConnectorRecord, 'toolPolicy' | 'status'>,
  fingerprint: Pick<ToolFingerprint, 'tool' | 'approved' | 'everApproved' | 'missing'> | undefined,
): ToolPolicy {
  if (!fingerprint || connector.status === 'disabled') return 'off';
  if (connectorToolState(fingerprint) !== 'ok') return 'off';
  return chosenToolPolicy(connector, fingerprint.tool);
}

/** The server says the tool only reads. A hint: the user still decides whether it runs without asking. */
export function toolClaimsReadOnly(fingerprint: Pick<ToolFingerprint, 'annotations'>): boolean {
  return fingerprint.annotations?.readOnlyHint === true && fingerprint.annotations?.destructiveHint !== true;
}

/** Whether a connector may be used from a workspace: only the workspaces the user bound it to. */
export function connectorBoundTo(
  connector: Pick<ConnectorRecord, 'workspaceIds'>,
  workspaceId: string | null,
): boolean {
  return workspaceId !== null && connector.workspaceIds.includes(workspaceId);
}
