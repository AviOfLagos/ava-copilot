import { describe, expect, it } from 'vitest';
import { checkConnectorUrl, CONNECTOR_CATALOG, connectorCatalogEntry } from '../catalog';
import { connectorBoundTo, connectorToolState, effectiveToolPolicy, toolClaimsReadOnly } from '../policy';

const connector = (toolPolicy: Record<string, 'read' | 'approve' | 'off'> = {}, status = 'connected' as const) => ({
  toolPolicy,
  status,
});
const tool = (changes: Partial<{ approved: boolean; everApproved: boolean; missing: boolean }> = {}) => ({
  tool: 'lookup',
  approved: true,
  everApproved: true,
  missing: false,
  ...changes,
});

describe('tool policy', () => {
  it('says where a tool stands: new, changed, missing or approved', () => {
    expect(connectorToolState(tool({ approved: false, everApproved: false }))).toBe('new');
    expect(connectorToolState(tool({ approved: false, everApproved: true }))).toBe('changed');
    expect(connectorToolState(tool({ missing: true }))).toBe('missing');
    expect(connectorToolState(tool())).toBe('ok');
  });

  it('asks first unless the user chose otherwise', () => {
    expect(effectiveToolPolicy(connector(), tool())).toBe('approve');
    expect(effectiveToolPolicy(connector({ lookup: 'read' }), tool())).toBe('read');
    expect(effectiveToolPolicy(connector({ lookup: 'off' }), tool())).toBe('off');
  });

  it('keeps new, changed and missing tools off whatever was chosen, and everything of a connector turned off', () => {
    const chosen = connector({ lookup: 'read' });
    expect(effectiveToolPolicy(chosen, tool({ approved: false, everApproved: false }))).toBe('off');
    expect(effectiveToolPolicy(chosen, tool({ approved: false }))).toBe('off');
    expect(effectiveToolPolicy(chosen, tool({ missing: true }))).toBe('off');
    expect(effectiveToolPolicy(chosen, undefined)).toBe('off');
    expect(effectiveToolPolicy({ toolPolicy: { lookup: 'read' }, status: 'disabled' }, tool())).toBe('off');
  });

  it('takes a read-only hint only when the tool does not also say it destroys', () => {
    expect(toolClaimsReadOnly({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(toolClaimsReadOnly({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(false);
    expect(toolClaimsReadOnly({ annotations: null })).toBe(false);
  });

  it('binds a connector to the workspaces picked, and none to a chat in no workspace', () => {
    expect(connectorBoundTo({ workspaceIds: ['w1'] }, 'w1')).toBe(true);
    expect(connectorBoundTo({ workspaceIds: ['w1'] }, 'w2')).toBe(false);
    expect(connectorBoundTo({ workspaceIds: [] }, 'w1')).toBe(false);
    expect(connectorBoundTo({ workspaceIds: ['w1'] }, null)).toBe(false);
  });
});

describe('connector addresses', () => {
  it('takes https anywhere and http only on this computer', () => {
    expect('url' in checkConnectorUrl('https://mcp.linear.app/mcp')).toBe(true);
    expect('url' in checkConnectorUrl('http://127.0.0.1:3000/mcp')).toBe(true);
    expect('url' in checkConnectorUrl('http://localhost/mcp')).toBe(true);
    expect('url' in checkConnectorUrl('http://[::1]:8080/mcp')).toBe(true);
    expect(checkConnectorUrl('http://192.168.1.4/mcp')).toEqual({ error: 'insecure' });
    expect(checkConnectorUrl('https://user:pass@example.com/mcp')).toEqual({ error: 'credentials' });
    expect(checkConnectorUrl('ftp://example.com')).toEqual({ error: 'invalid' });
    expect(checkConnectorUrl('not a url')).toEqual({ error: 'invalid' });
  });

  it('lists only https servers, each with its docs', () => {
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(entry.docsUrl.startsWith('https://')).toBe(true);
      expect(connectorCatalogEntry(entry.id)).toBe(entry);
    }
    expect(connectorCatalogEntry('nope')).toBeUndefined();
  });
});
