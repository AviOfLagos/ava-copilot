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

/** The sign-in window did not come back with an answer, for a reason worth telling (not the user closing it). */
export class SignInFailed extends Error {
  constructor(
    public readonly reason: 'page' | 'busy' | 'other',
    detail: string,
  ) {
    super(detail);
    this.name = 'SignInFailed';
  }
}

/**
 * What a failed launchWebAuthFlow means. Chrome says "The user did not approve access." when the window is
 * closed, "Authorization page could not be loaded." when the service showed an error or never answered (a wrong
 * client ID, a redirect address the service does not know), and refuses a second window while one is open.
 */
export function signInProblem(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/did not approve|cancel|closed/i.test(message)) return new SignInCancelled();
  if (/could not be loaded|page could not/i.test(message)) return new SignInFailed('page', message);
  if (/another|already|in progress|pending/i.test(message)) return new SignInFailed('busy', message);
  return new SignInFailed('other', message);
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
  } catch (error) {
    throw signInProblem(error);
  }
  if (!redirect) throw new SignInCancelled();
  return api.request<SignInResult>({ type: 'conn_oauth_finish', redirectUrl: redirect }, 90_000);
}
