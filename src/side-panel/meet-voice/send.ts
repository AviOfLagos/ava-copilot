/** A meet-voice command to the background as a one-off message; rejects with the background's sentence. */
export async function sendMeetVoice<T = Record<string, unknown>>(message: { type: string; [key: string]: unknown }) {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    (T & { type?: string; error?: string }) | undefined;
  if (!reply || reply.type === 'error') throw new Error(reply?.error || 'No answer from the background.');
  return reply;
}
