// The record types the shared workflow engine uses from @extension/storage (types only; nothing of the
// extension's storage runs on the Mac). Aliased in tsconfig.json, vitest and the build.
export type {
  RunRecord,
  RunStatus,
  RunStep,
  RunStepStatus,
  WorkflowRecord,
} from '../../../src/storage/lib/workflows/types';
