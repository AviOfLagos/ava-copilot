/**
 * Sends a follow-up command to the background, which is the only writer (src/background/followups). Resolves with the
 * command's result, rejects with the background's plain sentence.
 */
export async function followupsRequest<T = unknown>(
  message: { type: `followups_${string}` } & Record<string, unknown>,
): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: T } | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply.result as T;
}

/** "Mon 30 Nov" for a day given as a time. */
export const dayShort = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** "Thu 27 Nov" for an ISO day (YYYY-MM-DD). */
export function isoDayShort(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return dayShort(new Date(year, month - 1, day, 12).getTime());
}

export interface DraftReply {
  text: string;
  facts: { name: string; task: string; from: string | null; date: string | null };
  byModel: boolean;
}
