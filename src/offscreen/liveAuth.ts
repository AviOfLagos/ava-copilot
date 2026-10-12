/**
 * The address a Gemini Live socket opens. With Google's own endpoint, the offscreen document never
 * holds the API key: it asks the background for a short-lived, single-use token for each connection
 * (the background mints it with the key). Test endpoints still use a key.
 */
export interface LiveAuthOptions {
  endpoint: string;
  apiKey: string;
  // Ask the background for a one-use token instead of putting the key in the address
  tokenAuth?: boolean;
}

export async function liveSocketUrl(options: LiveAuthOptions): Promise<string> {
  if (!options.tokenAuth) return `${options.endpoint}?key=${encodeURIComponent(options.apiKey)}`;
  const reply = (await chrome.runtime.sendMessage({ type: 'models_live_token' })) as
    { ok: true; token: string; endpoint: string } | { ok: false; error?: string } | undefined;
  if (!reply?.ok) throw new Error(reply?.error || 'Could not get a voice token.');
  return `${reply.endpoint}?access_token=${encodeURIComponent(reply.token)}`;
}
