import { describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '@extension/storage';
import { noticeFor, VOICE_TOOLS } from '../prompt';

const request = (fields: Partial<ConfirmRequest>): ConfirmRequest => ({
  id: 'r',
  taskId: 't',
  mode: 'commit',
  kind: 'send',
  intent: '',
  target: 'Send message',
  pageTitle: '',
  pageUrl: '',
  fields: [],
  context: '',
  ...fields,
});

describe('noticeFor', () => {
  it('says a send waits for the Confirm click, never that it was sent', () => {
    const notice = noticeFor({
      title: 'Post standup',
      status: 'waiting_confirm',
      pendingRequest: request({}),
      error: null,
    });
    expect(notice).toBe(
      '"Post standup" is ready to send: Send message. It waits for their click on Confirm in the side panel.',
    );
  });

  it('asks the user to do a sign-in step on the page', () => {
    const notice = noticeFor({
      title: 'Check invoices',
      status: 'waiting_confirm',
      pendingRequest: request({ mode: 'needs_user', kind: 'login' }),
      error: null,
    });
    expect(notice).toContain('sign in, then click Continue');
  });

  it('reports a finished task with its result, kept short', () => {
    const notice = noticeFor(
      { title: 'Price check', status: 'idle', pendingRequest: null, error: null },
      'x'.repeat(1000),
    );
    expect(notice?.startsWith('"Price check" is done. The result: ')).toBe(true);
    expect(notice!.length).toBeLessThan(360);
  });

  it('reports a failure, and says nothing while running', () => {
    expect(
      noticeFor({
        title: 'Form',
        status: 'error',
        pendingRequest: null,
        error: { kind: 'tab_closed', message: 'The tab closed.' },
      }),
    ).toBe('"Form" stopped: The tab closed..');
    expect(noticeFor({ title: 'Form', status: 'running', pendingRequest: null, error: null })).toBeNull();
  });
});

describe('VOICE_TOOLS', () => {
  it('offers no tool that could approve or send on its own', () => {
    expect(VOICE_TOOLS.map(tool => tool.name)).toEqual(['run_browser_task', 'ask_meeting', 'get_status', 'stop_tasks']);
  });
});
