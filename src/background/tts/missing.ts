/** Whether an on-device voice failed because its files are not there (not downloaded, or did not load). */
export function missingVoiceFiles(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found locally|local_files_only|allowRemoteModels|not downloaded|failed to load|could not load|\b404\b/i.test(
    message,
  );
}
