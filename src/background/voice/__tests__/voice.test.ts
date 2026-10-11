import { describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '@extension/storage';
import { noticeFor, VOICE_TOOLS, voiceHistory } from '../prompt';

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
    expect(VOICE_TOOLS.map(tool => tool.name)).toEqual([
      'run_browser_task',
      'list_tabs',
      'read_page',
      'open_tab',
      'switch_tab',
      'get_brief',
      'get_schedule',
      'join_next_meeting',
      'leave_call',
      // Acts on others, so it runs only on the user's own words (spokeEnd)
      'end_call_for_everyone',
      'list_frequent_sites',
      'remember_this',
      'think',
      'ask_meeting',
      'ask_knowledge',
      'get_status',
      'stop_tasks',
    ]);
  });
});

describe('voiceHistory', () => {
  it('gives the end of the conversation, words only, framed as history', () => {
    const history = voiceHistory([
      { actor: 'user', content: 'Open my email' },
      { actor: 'navigator', content: 'Clicking Inbox' },
      { actor: 'planner', content: 'Opened Gmail.' },
    ]);
    expect(history).toMatch(/^Earlier in this conversation/);
    expect(history).toContain('User: Open my email\nYou: Opened Gmail.');
    expect(history).not.toContain('Clicking');
    expect(voiceHistory([])).toBe('');
  });

  it('keeps the newest turns when the conversation is long', () => {
    const turns = Array.from({ length: 400 }, (_, i) => ({ actor: 'user', content: `turn ${i} ${'x'.repeat(40)}` }));
    const history = voiceHistory(turns);
    expect(history).toContain('turn 399');
    expect(history).not.toContain('turn 0 ');
    expect(history.length).toBeLessThan(7000);
    expect(history).toContain('nano_untrusted_content');
  });
});

describe('voice tool guard', () => {
  it('guards every tool but stopping tasks, and names each one', async () => {
    const { TOOL_ACTIONS, UNGUARDED_TOOLS } = await import('../guard');
    expect([...UNGUARDED_TOOLS]).toEqual(['stop_tasks']);
    for (const tool of VOICE_TOOLS) {
      if (!UNGUARDED_TOOLS.has(tool.name)) expect(TOOL_ACTIONS[tool.name], tool.name).toBeTruthy();
    }
  });
});
