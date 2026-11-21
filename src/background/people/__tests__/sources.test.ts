import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { WatcherConversation } from '../../inbox/watchers/types';
import { githubPeople, gmailInputs, slackInputs, whatsappInput } from '../sources';

// Made-up people and addresses only
const row = (over: Partial<WatcherConversation>): WatcherConversation =>
  ({ externalId: 'x1', sender: '', preview: '', unread: true, ...over }) as WatcherConversation;

describe('Gmail rows', () => {
  it("learns a sender's name and address, never a service address or the owner's own", () => {
    const inputs = gmailInputs(
      [
        row({ externalId: 'a', sender: 'Tolu Bello', senderEmail: 'Tolu@Example.test' }),
        row({ externalId: 'b', sender: 'Acme', senderEmail: 'no-reply@acme.test' }),
        row({ externalId: 'c', sender: 'Updates', senderEmail: 'notifications@forge.test' }),
        row({ externalId: 'd', sender: 'me', senderEmail: 'owner@example.test' }),
        row({ externalId: 'e', sender: 'No address' }),
        row({ externalId: 'f', sender: '', senderEmail: 'kemi@example.test' }),
      ],
      new Set(['owner@example.test']),
    );
    expect(inputs.map(input => [input.text, input.email, input.ref])).toEqual([
      ['Tolu Bello', 'tolu@example.test', 'gmail-web|a'],
      ['kemi', 'kemi@example.test', 'gmail-web|f'],
    ]);
    expect(inputs.every(input => input.source === 'gmail' && input.workspaceId === null)).toBe(true);
  });
});

describe('Slack rows', () => {
  it('learns direct messages only, with their id as the handle, once a day', () => {
    const inputs = slackInputs(
      [
        row({ externalId: 'D01', sender: 'Kemi Ade', isPerson: true, senderHandle: 'D01' }),
        row({ externalId: 'C01', sender: 'general', isPerson: false }),
        row({ externalId: 'C02', sender: 'design' }),
      ],
      '2026-11-21',
    );
    expect(inputs).toEqual([
      expect.objectContaining({
        text: 'Kemi Ade',
        source: 'slack',
        handle: { kind: 'slack', value: 'D01' },
        ref: 'slack-web|D01|2026-11-21',
      }),
    ]);
  });
});

describe('WhatsApp chats', () => {
  it('a saved name is a name; a chat with no saved name is its number', () => {
    expect(whatsappInput('Ngozi', 'ws', 'r', 'c')).toMatchObject({ text: 'Ngozi', phone: null });
    expect(whatsappInput('+234 801 234 5678', 'ws', 'r', 'c')).toMatchObject({
      phone: '+234 801 234 5678',
      handle: { kind: 'whatsapp', value: '+234 801 234 5678' },
    });
    expect(whatsappInput('  ', 'ws', 'r', 'c')).toBeNull();
  });
});

describe('GitHub results', () => {
  it('reads authors, assignees and reviewers, never bots, with the issue they were on', () => {
    const text = JSON.stringify([
      {
        number: 7,
        html_url: 'https://github.com/acme/app/pull/7',
        user: { login: 'kunle-dev', type: 'User' },
        assignees: [{ login: 'ada-o' }, { login: 'renovate[bot]', type: 'Bot' }],
        requested_reviewers: [{ login: 'tolu', name: 'Tolu Bello' }],
        body: 'login: "not-a-person"',
      },
    ]);
    expect(githubPeople(text)).toEqual([
      { login: 'kunle-dev', name: null, ref: 'https://github.com/acme/app/pull/7' },
      { login: 'ada-o', name: null, ref: 'https://github.com/acme/app/pull/7' },
      { login: 'tolu', name: 'Tolu Bello', ref: 'https://github.com/acme/app/pull/7' },
    ]);
  });

  it('reads a result that was cut short as far as it goes', () => {
    const text = '[{"number":1,"user":{"login":"kunle-dev","id":1},"assignee":{"login":"ada-o"},"body":"tru';
    expect(githubPeople(text).map(person => person.login)).toEqual(['kunle-dev', 'ada-o']);
  });
});
