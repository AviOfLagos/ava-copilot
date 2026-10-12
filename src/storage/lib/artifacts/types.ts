/** Something an agent made to look at: a page, a design, an animation. */
export interface ArtifactRecord {
  id: string;
  title: string;
  kind: 'html' | 'svg' | 'image' | 'site';
  workspaceId: string | null;
  agentId: string | null;
  runId: string | null;
  // A single-file artifact's content, shown in the sandboxed viewer
  content: string | null;
  // A built site served by the companion
  url: string | null;
  createdAt: number;
}
