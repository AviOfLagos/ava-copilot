import { db as defaultDb } from '@extension/storage';
import type { AgentProfile, AviCopilotDb, ConnectorRecord, ToolFingerprint, ToolPolicy } from '@extension/storage';
import { reconcileHashed } from './fingerprint';
import type { HashedTool, Reconciled } from './fingerprint';

/**
 * Connectors and their tool fingerprints in the database. The background is the only writer. Whatever reads a
 * connector's tool choices and writes them back does it in one transaction, so two quick choices in the panel,
 * or a choice made while the tools are being read again, never undo each other.
 */
export class ConnectorStore {
  constructor(private readonly database: AviCopilotDb = defaultDb) {}

  get(id: string): Promise<ConnectorRecord | undefined> {
    return this.database.connectors.get(id);
  }

  list(): Promise<ConnectorRecord[]> {
    return this.database.connectors.toArray();
  }

  async put(record: ConnectorRecord): Promise<void> {
    await this.database.connectors.put(record);
  }

  /** Changes some fields of a connector; never its tool choices (see approveTools and applyListing). */
  async update(id: string, changes: Partial<ConnectorRecord>): Promise<ConnectorRecord | undefined> {
    await this.database.connectors.update(id, { ...changes, updatedAt: Date.now() });
    return this.get(id);
  }

  /** Removes a connector and every fingerprint of its tools. */
  async remove(id: string): Promise<void> {
    await this.database.transaction('rw', this.database.connectors, this.database.toolFingerprints, async () => {
      await this.database.toolFingerprints.where('connectorId').equals(id).delete();
      await this.database.connectors.delete(id);
    });
  }

  fingerprints(connectorId: string): Promise<ToolFingerprint[]> {
    return this.database.toolFingerprints.where('connectorId').equals(connectorId).toArray();
  }

  fingerprint(connectorId: string, tool: string): Promise<ToolFingerprint | undefined> {
    return this.database.toolFingerprints.get(`${connectorId}:${tool}`);
  }

  /**
   * Approves tools as the user saw them and records the policy chosen for each. A tool that changed meanwhile
   * (another hash) or is gone is left out.
   *
   * @returns The tools approved
   */
  async approveTools(
    connectorId: string,
    choices: { tool: string; hash: string; policy: ToolPolicy }[],
  ): Promise<string[]> {
    const { connectors, toolFingerprints } = this.database;
    return this.database.transaction('rw', connectors, toolFingerprints, async () => {
      const approved = new Map<string, ToolPolicy>();
      for (const choice of choices) {
        const id = `${connectorId}:${choice.tool}`;
        const fingerprint = await toolFingerprints.get(id);
        if (!fingerprint || fingerprint.missing || fingerprint.hash !== choice.hash) continue;
        await toolFingerprints.update(id, { approved: true, everApproved: true, previous: null, changedAt: null });
        approved.set(choice.tool, choice.policy);
      }
      if (approved.size) {
        await connectors
          .where('id')
          .equals(connectorId)
          .modify(record => {
            record.toolPolicy = { ...record.toolPolicy, ...Object.fromEntries(approved) };
            record.updatedAt = Date.now();
          });
      }
      return [...approved.keys()];
    });
  }

  /**
   * Stores a fresh listing: compares it with the stored fingerprints, writes them, forgets the choice made for
   * every tool that changed, and records `changes` on the connector — all in one transaction.
   */
  async applyListing(
    connectorId: string,
    listed: HashedTool[],
    now: number,
    changes: Partial<ConnectorRecord>,
  ): Promise<Reconciled> {
    const { connectors, toolFingerprints } = this.database;
    return this.database.transaction('rw', connectors, toolFingerprints, async () => {
      const stored = await toolFingerprints.where('connectorId').equals(connectorId).toArray();
      const result = reconcileHashed(connectorId, listed, stored, now);
      if (result.records.length) await toolFingerprints.bulkPut(result.records);
      await connectors
        .where('id')
        .equals(connectorId)
        .modify(record => {
          Object.assign(record, changes);
          // A changed tool's old choice does not carry over: approved again, it asks first until the user says
          if (result.changed.length) {
            record.toolPolicy = { ...record.toolPolicy };
            for (const tool of result.changed) delete record.toolPolicy[tool];
          }
          record.updatedAt = Date.now();
        });
      return result;
    });
  }

  /** An agent's profile: it names the connectors the agent may use. */
  agent(id: string): Promise<AgentProfile | undefined> {
    return this.database.agents.get(id);
  }

  /** Forgets a connector's tools and the choices made for them, e.g. when its address changes to another server. */
  async clearTools(connectorId: string): Promise<void> {
    const { connectors, toolFingerprints } = this.database;
    await this.database.transaction('rw', connectors, toolFingerprints, async () => {
      await toolFingerprints.where('connectorId').equals(connectorId).delete();
      await connectors.update(connectorId, { toolPolicy: {}, toolsCheckedAt: null, updatedAt: Date.now() });
    });
  }
}
