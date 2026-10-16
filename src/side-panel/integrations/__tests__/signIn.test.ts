import { describe, expect, it, vi } from 'vitest';
import { runSignIn, SignInCancelled, SignInFailed, signInProblem } from '../signIn';

const REDIRECT = 'https://fckijnclcihjnokahdnbogpbeiimfdio.chromiumapp.org/';

function fakeApi() {
  const sent: Record<string, unknown>[] = [];
  const request = vi.fn(async <T>(message: Record<string, unknown>): Promise<T> => {
    sent.push(message);
    if (message.type === 'conn_oauth_start') {
      return {
        authorizationUrl: `https://auth.example/authorize?state=s1&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      } as T;
    }
    return { connectorId: 'c1', tools: 4, refreshError: null } as T;
  });
  return { api: { request: request as never }, sent };
}

describe('signing in from the panel', () => {
  it('opens the service’s page with launchWebAuthFlow and hands where it came back to the background', async () => {
    const { api, sent } = fakeApi();
    const launch = vi.fn(async (url: string) => `${REDIRECT}?code=abc&state=${new URL(url).searchParams.get('state')}`);
    const result = await runSignIn(api, 'c1', launch);
    expect(launch).toHaveBeenCalledWith(expect.stringContaining('https://auth.example/authorize'));
    expect(sent).toEqual([
      { type: 'conn_oauth_start', id: 'c1' },
      { type: 'conn_oauth_finish', redirectUrl: `${REDIRECT}?code=abc&state=s1` },
    ]);
    expect(result).toEqual({ connectorId: 'c1', tools: 4, refreshError: null });
  });

  it('says the sign-in was cancelled when the window closes, and finishes nothing', async () => {
    const { api, sent } = fakeApi();
    const launch = vi.fn(async () => {
      throw new Error('The user did not approve access.');
    });
    await expect(runSignIn(api, 'c1', launch)).rejects.toBeInstanceOf(SignInCancelled);
    expect(sent.map(message => message.type)).toEqual(['conn_oauth_start']);
    await expect(runSignIn(api, 'c1', async () => undefined)).rejects.toBeInstanceOf(SignInCancelled);
  });

  it('tells a page that would not load (wrong client ID or redirect) apart from the user closing the window', async () => {
    const { api } = fakeApi();
    const launch = vi.fn(async () => {
      throw new Error('Authorization page could not be loaded.');
    });
    const problem = await runSignIn(api, 'c1', launch).catch(error => error);
    expect(problem).toBeInstanceOf(SignInFailed);
    expect((problem as SignInFailed).reason).toBe('page');
    expect(signInProblem(new Error('Another sign-in is already in progress'))).toMatchObject({ reason: 'busy' });
    expect(signInProblem(new Error('Something odd'))).toMatchObject({ reason: 'other', message: 'Something odd' });
    expect(signInProblem(new Error('The user did not approve access.'))).toBeInstanceOf(SignInCancelled);
  });
});
