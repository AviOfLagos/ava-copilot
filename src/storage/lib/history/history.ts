import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/** One folder of AI history the user brought in, e.g. their `~/.claude` folder or a ChatGPT export. */
export interface HistoryImport {
  id: string;
  // The folder's name, as the picker gave it
  label: string;
  // The tools found in it so far, e.g. ['claude-code']
  tools: string[];
  createdAt: number;
  lastImportAt: number | null;
  // What the last pass did
  lastCounts: { added: number; updated: number; unchanged: number; redacted: number; capped: boolean } | null;
}

/** A source a summary drew on, numbered as the summary cites it. */
export interface SummarySource {
  n: number;
  itemId: string;
  title: string;
  sourceType: string;
  date: number;
}

/** A workspace's rolling "where we are", built from that workspace's own items only. */
export interface WorkspaceSummary {
  // A workspace id, or GENERAL_SUMMARY_ID for what belongs to no workspace
  workspaceId: string;
  text: string;
  // The "Next actions" lines, for the all-workspaces roll-up and the morning brief
  actions: string[];
  sources: SummarySource[];
  // The newest item it read, and a fingerprint of all it read, to know when it is out of date
  latestAt: number;
  fingerprint: string;
  itemCount: number;
  builtAt: number;
  // Written from the items alone, without a model (none set up, or over the day's budget)
  plain: boolean;
}

export const GENERAL_SUMMARY_ID = '_general';

interface HistoryState {
  imports: HistoryImport[];
  // Project folder → workspace, as the user mapped it (null: keep it out of any workspace)
  projects: Record<string, string | null>;
  summaries: Record<string, WorkspaceSummary>;
}

const storage = createStorage<HistoryState>(
  'ai-history',
  { imports: [], projects: {}, summaries: {} },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

const MAX_PROJECT_MAPPINGS = 500;

/** Imported AI history's bookkeeping and the workspace summaries. The background is the only writer. */
export const historyStore = {
  ...storage,

  async imports(): Promise<HistoryImport[]> {
    return (await storage.get()).imports;
  },

  async saveImport(record: HistoryImport): Promise<void> {
    await storage.set(state => ({
      ...state,
      imports: state.imports.some(item => item.id === record.id)
        ? state.imports.map(item => (item.id === record.id ? record : item))
        : [...state.imports, record],
    }));
  },

  async removeImport(id: string): Promise<void> {
    await storage.set(state => ({ ...state, imports: state.imports.filter(item => item.id !== id) }));
  },

  async projects(): Promise<Record<string, string | null>> {
    return (await storage.get()).projects;
  },

  async mapProject(project: string, workspaceId: string | null | undefined): Promise<void> {
    await storage.set(state => {
      const projects = { ...state.projects };
      if (workspaceId === undefined) delete projects[project];
      else projects[project] = workspaceId;
      const keys = Object.keys(projects);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PROJECT_MAPPINGS))) delete projects[key];
      return { ...state, projects };
    });
  },

  async summaries(): Promise<Record<string, WorkspaceSummary>> {
    return (await storage.get()).summaries;
  },

  async saveSummary(summary: WorkspaceSummary): Promise<void> {
    await storage.set(state => ({ ...state, summaries: { ...state.summaries, [summary.workspaceId]: summary } }));
  },

  async removeSummary(workspaceId: string): Promise<void> {
    await storage.set(state => {
      const summaries = { ...state.summaries };
      delete summaries[workspaceId];
      return { ...state, summaries };
    });
  },
};
