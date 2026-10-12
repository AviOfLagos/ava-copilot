import type { PanelApi } from '../registry';

/**
 * Signing in to a connector from the panel. The background prepares the sign-in (and keeps its PKCE verifier and
 * state); the panel opens the service's page with chrome.identity.launchWebAuthFlow, which returns once the
 * service sends the user to https://<extension id>.chromiumapp.org/; the background checks and finishes it. The
 * wait for the user happens here, in the page, so a background stopped meanwhile loses nothing.
 */

export type LaunchWebAuthFlow = (url: string) => Promise<string | undefined>;

export const launchWebAuthFlow: LaunchWebAuthFlow = url =>
  chrome.identity.launchWebAuthFlow({ url, interactive: true });

export class SignInCancelled extends Error {
  constructor() {
    super('The sign-in was cancelled.');
    this.name = 'SignInCancelled';
  }
}

export interface SignInResult {
  connectorId: string;
  tools: number | null;
  refreshError: string | null;
}

export async function runSignIn(
  api: Pick<PanelApi, 'request'>,
  connectorId: string,
  launch: LaunchWebAuthFlow = launchWebAuthFlow,
): Promise<SignInResult> {
  const { authorizationUrl } = await api.request<{ authorizationUrl: string }>(
    { type: 'conn_oauth_start', id: connectorId },
    60_000,
  );
  let redirect: string | undefined;
  try {
    redirect = await launch(authorizationUrl);
  } catch {
    // Closing the window, or the service refusing to show it, ends here
    throw new SignInCancelled();
  }
  if (!redirect) throw new SignInCancelled();
  return api.request<SignInResult>({ type: 'conn_oauth_finish', redirectUrl: redirect }, 90_000);
}
